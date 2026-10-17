import {
  resolveVideoProfile,
  checkNarrationDuration,
  canvasGuidanceFor,
  wordRangeFor,
  speakingRateWordsPerSecond,
} from "../utils/video-profile.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  ScriptQAOutput,
  VideoProfileConfig,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ScriptQAOutputSchema } from "../schemas/script-qa-output.js";
import { config as configUtils } from "../utils/config.js";
import {
  formatScriptComplexityReport,
  validateScriptComplexity,
} from "../utils/script-complexity.js";
import { hashIssues } from "../utils/qa-policy.js";
import { hashObject } from "../artifacts/hash.js";
import { checkScriptContract } from "../utils/script-contract.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import {
  tryClassifyQaGate,
  buildGateState,
  injectFromConfigurable,
} from "../classifiers/index.js";

function serializeFacts(
  facts:
    | {
        id: string;
        fact: string;
        confidence: string;
        classification?: string;
      }[]
    | undefined,
): string {
  if (!facts || facts.length === 0) return "";
  return facts
    .map((f) => {
      const cls = f.classification
        ? `\nClassification: ${f.classification}`
        : "";
      return `${f.id}\nConfidence: ${f.confidence}${cls}\n${f.fact}`;
    })
    .join("\n\n");
}

/**
 * Planner beats merged with the writer's narration for each beat. The flat
 * narration cannot be judged per beat: check 5 reads the join between two
 * beats and check 16 reads the closing beat that must pay a loop off, so both
 * need the narration attributed to its beat.
 */
function serializeBeats(
  beats:
    | {
        beatId: number;
        purpose: string;
        curiosityQuestion?: string;
        keyMessage: string;
      }[]
    | undefined,
  writerBeats: { beatId: number; narration: string }[] | undefined,
): string {
  if (!beats || beats.length === 0) return "";
  const narrationByBeat = new Map(
    (writerBeats ?? []).map((b) => [b.beatId, b.narration]),
  );
  return beats
    .map((b) => {
      const curiosity = b.curiosityQuestion
        ? `\nCuriosity Question: ${b.curiosityQuestion}`
        : "";
      const narration = narrationByBeat.get(b.beatId);
      const narrationLine = narration ? `\nNarration: ${narration}` : "";
      return `Beat ${b.beatId}\nPurpose: ${b.purpose}${curiosity}\nKey Message: ${b.keyMessage}${narrationLine}`;
    })
    .join("\n\n");
}

function serializeBeatWordCounts(
  counts: { beatId: number; words: number; targetWords?: number }[],
): string {
  if (!counts || counts.length === 0) return "";
  return counts
    .map(
      (c) =>
        `Beat ${c.beatId}: ${c.words} words${c.targetWords !== undefined ? ` (target ${c.targetWords})` : ""}`,
    )
    .join("\n");
}

function serializeBeatBoundaries(
  boundaries: {
    fromBeatId: number;
    toBeatId: number;
    previousLastSentence: string;
    nextFirstSentence: string;
  }[],
): string {
  if (!boundaries || boundaries.length === 0) return "";
  return boundaries
    .map(
      (b) =>
        `Beat ${b.fromBeatId} -> Beat ${b.toBeatId}\n  ends: ${b.previousLastSentence}\n  starts: ${b.nextFirstSentence}`,
    )
    .join("\n");
}

function serializeOpenLoops(
  loops: {
    beatId: number;
    opensLoop?: string;
    closesLoopFor?: number | null;
  }[],
): string {
  if (!loops || loops.length === 0) return "";
  return loops
    .map((l) => {
      const closes =
        l.closesLoopFor !== null && l.closesLoopFor !== undefined
          ? `closes loop from beat ${l.closesLoopFor}`
          : "closes nothing";
      return `Beat ${l.beatId}: ${l.opensLoop ? `opens "${l.opensLoop}"` : "opens no loop"} | ${closes}`;
    })
    .join("\n");
}

export async function scriptQANode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  scriptQA: ScriptQAOutput;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { script, narration, callToAction, estimatedDurationSeconds } =
    state.content ?? {};
  const research = state.research;
  const videoProfile: VideoProfileConfig =
    state.videoProfile ?? resolveVideoProfile({});
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount = (state.execution?.retryCount?.ScriptQA ?? 0) + 1;
  const execution = (currentNode: string) => ({
    currentNode,
    retryCount: { ...state.execution?.retryCount, ScriptQA: retryCount },
  });

  if (!script || !narration) {
    return {
      scriptQA: {
        status: "minor_revision",
        feedback: "Script QA: no script or narration to review.",
        issues: ["Missing script or narration"],
      },
      diagnostics: {},
      execution: execution(AgentModel.ScriptQA),
    };
  }

  const complexityReport = validateScriptComplexity(narration);
  const complexityFeedback = formatScriptComplexityReport(complexityReport);

  // Language complexity is a deterministic pipeline invariant. LLM QA can be
  // disabled to save cost, but explicit sentence and language limits still
  // apply before narration reaches TTS.
  if (!complexityReport.passed) {
    return {
      scriptQA: {
        status: "minor_revision",
        feedback: `Script QA: simplify narration for global listening comprehension.\n${complexityFeedback}`,
        issues: complexityReport.issues.map((issue) => issue.message),
      },
      diagnostics: {},
      execution: execution(AgentModel.ScriptQA),
    };
  }

  // Deterministic duration/word-count gate (only when explicit profile/target requested)
  if (videoProfile.explicit) {
    const durationIssues = checkNarrationDuration(
      videoProfile,
      narration,
      estimatedDurationSeconds ?? videoProfile.targetDurationSec,
    );
    if (durationIssues.length > 0) {
      return {
        scriptQA: {
          status: "minor_revision",
          feedback: `Script QA: duration/word-count mismatch.\n${durationIssues.join("\n")}`,
          issues: durationIssues,
        },
        diagnostics: {},
        execution: execution(AgentModel.ScriptQA),
      };
    }
  }

  // Deterministic re-verification of the writer's declared retention contract
  // (ending type, ending-narration suffix, pivot existence, pivot→beat
  // containment, beat mapping, per-beat budgets). Fail-closed like the schema
  // gates above for BLOCKING issues: code must not delegate structurally
  // checkable invariants to the LLM. A contract violation is BLOCKING — the QA
  // retry policy would otherwise accept the best available script after one
  // minor revision even though the declared anchors (ending, pivot) do not
  // actually hold.
  //
  // Warn-severity issues are advisory: they are handed to the LLM reviewer as
  // context (and are not, on their own, grounds to reject), which is what lets
  // a heuristic check ship without vetoing drafts overnight.
  const contract = checkScriptContract(state, narration);
  const blockingIssues = contract.issues.filter(
    (issue) => issue.severity === "block",
  );
  const warningIssues = contract.issues.filter(
    (issue) => issue.severity === "warn",
  );
  if (blockingIssues.length > 0) {
    return {
      scriptQA: {
        status: "major_revision",
        feedback: `Script QA: retention contract violation.\n${blockingIssues
          .map((issue) => issue.message)
          .join("\n")}`,
        issues: blockingIssues.map((issue) => issue.message),
      },
      diagnostics: {},
      execution: execution(AgentModel.ScriptQA),
    };
  }

  if (!configUtils.enableScriptQA()) {
    return {
      scriptQA: { status: "approved" } as ScriptQAOutput,
      diagnostics: {},
      execution: {},
    };
  }

  const canvasGuidance = canvasGuidanceFor(videoProfile);
  const wordRange = wordRangeFor(videoProfile);
  const speakingRate = speakingRateWordsPerSecond(videoProfile);

  const label = nodeLabel(AgentModel.ScriptQA);
  logger.nodeStart(label);
  logger.nodePhase(label, "checking script");

  const gateState = buildGateState("scriptqa", state);
  const classified = gateState
    ? await tryClassifyQaGate("scriptqa", {
        state: gateState.state,
        agent: AgentModel.ScriptQA,
        inject: injectFromConfigurable(
          (config.configurable ?? {}) as Record<string, unknown>,
        ),
        promptVersion: PromptPaths.ScriptQA.replace(/\.md$/, ""),
      })
    : null;

  if (classified && classified.prediction.status === "approved") {
    logger.nodeDone(label, classified.telemetry.durationMs);
    return {
      scriptQA: { status: "approved" } as ScriptQAOutput,
      diagnostics: {
        telemetry: { [AgentModel.ScriptQA]: classified.telemetry },
      },
      execution: execution(AgentModel.ScriptQA),
    };
  }

  // For long profile, only enforce minimum word count
  const targetWordRange =
    videoProfile.profile === "long"
      ? `at least ${wordRange.min}`
      : `${wordRange.min}-${wordRange.max}`;

  const derivation = contract.derivation;

  const result = await runAgent<ScriptQAOutput>({
    agent: AgentModel.ScriptQA,
    promptPath: PromptPaths.ScriptQA,
    schema: ScriptQAOutputSchema,
    variables: {
      script: script ?? "",
      narration: narration ?? "",
      cta: callToAction ?? "",
      estimatedDurationSeconds: String(
        estimatedDurationSeconds ?? videoProfile.targetDurationSec,
      ),
      targetDurationSeconds: String(videoProfile.targetDurationSec),
      targetWordRange,
      speakingRateWordsPerSecond: String(speakingRate),
      researchFacts: serializeFacts(research?.facts),
      storyBeats: serializeBeats(
        state.storyPlan?.storyBeats,
        state.content?.beats,
      ),
      audienceTrigger: state.storyPlan?.audienceTrigger?.type ?? "",
      audienceTriggerStatement:
        state.storyPlan?.audienceTrigger?.statement ?? "",
      audienceTriggerFactIds:
        state.storyPlan?.audienceTrigger?.factIds?.join(", ") ?? "",
      endingType: state.storyPlan?.endingType ?? "",
      derivedHookSentence: derivation.hookSentence,
      derivedPivotWordPosition: String(derivation.pivotWordPosition ?? -1),
      pivotBeatId: String(derivation.pivotBeatId ?? ""),
      pivotFactId: derivation.pivotFactId ?? "",
      beatWordCounts: serializeBeatWordCounts(derivation.beatWordCounts),
      beatBoundaries: serializeBeatBoundaries(derivation.beatBoundaries),
      openLoops: serializeOpenLoops(derivation.openLoops),
      contractWarnings: warningIssues
        .map((issue) => `- ${issue.message}`)
        .join("\n"),
      complexityReport: complexityFeedback,
      canvasGuidance: canvasGuidance.formatGuidance,
    },
    inject,
    configurable: withTopic(config, state).configurable,
    generateOptions: {
      temperature: 0.3,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    if (classified && classified.prediction.status !== "approved") {
      logger.nodeDone(label, classified.telemetry.durationMs);
      return {
        scriptQA: {
          status: classified.prediction.status as ScriptQAOutput["status"],
          feedback: `Script QA (classifier): ${classified.prediction.status}`,
          issues: [result.error ?? "LLM call failed"],
        },
        diagnostics: {
          telemetry: { [AgentModel.ScriptQA]: classified.telemetry },
        },
        execution: execution(AgentModel.ScriptQA),
      };
    }
    // QA infra failure (not a content verdict): signal the router to retry
    // this cheap QA node instead of regenerating the whole script.
    logger.nodeFailed(label, result.error ?? "LLM call failed");
    return {
      scriptQA: {
        status: "retry",
        feedback: `Script QA: ${result.error}`,
        issues: [result.error ?? "LLM call failed"],
      },
      diagnostics: {
        telemetry: { [AgentModel.ScriptQA]: result.telemetry },
      },
      execution: execution(AgentModel.ScriptQA),
    };
  }

  logger.nodeDone(label, result.telemetry.durationMs);

  let qa = result.data;
  if (classified && classified.prediction.status !== "approved") {
    qa = {
      ...qa,
      status: classified.prediction.status as ScriptQAOutput["status"],
    };
  }

  const isRevision =
    qa.status === "minor_revision" ||
    qa.status === "major_revision" ||
    qa.status === "fatal";
  const feedbackHash = hashIssues(qa.issues, qa.feedback);
  const previousHash = state.execution?.qaFeedback?.[AgentModel.ScriptQA];
  const repeated = isRevision && previousHash === feedbackHash;

  // Non-convergence guard: when the producer re-submitted a hash-identical
  // script while QA still issues a revision, more regenerations cannot change
  // the outcome, so the router stops early (accept/fail) instead of burning
  // the remaining budget. Artifacts are normalized to the narrated content —
  // derived fields (durations, counts) are excluded.
  const artifactHash = hashObject({
    script: script ?? "",
    beats: (state.content?.beats ?? []).map(
      (b: { beatId: number; narration: string }) => ({
        beatId: b.beatId,
        narration: b.narration,
      }),
    ),
    ending: state.content?.ending ?? null,
  });
  const previousArtifactHash =
    state.execution?.qaArtifactHash?.[AgentModel.ScriptQA];
  const artifactUnchanged = isRevision && previousArtifactHash === artifactHash;

  const qaOutput: ScriptQAOutput = repeated
    ? { ...qa, repeated: true }
    : artifactUnchanged
      ? { ...qa, artifactUnchanged: true }
      : qa;

  return {
    scriptQA: qaOutput,
    diagnostics: {
      ...(qa.status === "fatal"
        ? {
            errors: [
              `${AgentModel.ScriptQA}: ${qa.feedback ?? "script is unusable"}`,
            ],
          }
        : {}),
      telemetry: { [AgentModel.ScriptQA]: result.telemetry },
    },
    execution: {
      currentNode: AgentModel.ScriptQA,
      retryCount: { ...state.execution?.retryCount, ScriptQA: retryCount },
      ...(isRevision
        ? {
            qaFeedback: {
              ...state.execution?.qaFeedback,
              [AgentModel.ScriptQA]: feedbackHash,
            },
            qaArtifactHash: {
              ...state.execution?.qaArtifactHash,
              [AgentModel.ScriptQA]: artifactHash,
            },
          }
        : {}),
    },
  };
}
