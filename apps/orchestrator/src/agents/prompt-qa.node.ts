import {
  resolveVideoProfile,
  canvasGuidanceFor,
} from "../utils/video-profile.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
  VideoProfileConfig,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { PromptQAOutputSchema } from "../schemas/prompt-qa-output.js";
import type {
  PromptQAOutput,
  SceneResult,
} from "../schemas/prompt-qa-output.js";
import { config as configUtils } from "../utils/config.js";
import { hashIssues } from "../utils/qa-policy.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import {
  tryClassifyQaGate,
  buildGateState,
  injectFromConfigurable,
} from "../classifiers/index.js";
import type { QaPrediction } from "../eval/types.js";

function formatScenes(scenes: Scene[]): string {
  return JSON.stringify(
    scenes.map((s) => ({
      sceneId: s.sceneId,
      generationPrompt: s.generationPrompt,
      assetType: s.assetType,
      visualDescription: s.visualDescription,
      narration: s.narration,
    })),
    null,
    2,
  );
}

function formatVisualPlan(
  scenes: Scene[],
  visualPlan: {
    sceneId: number;
    renderStyle: string;
    colorMood: string;
    lighting: string;
    composition: string;
    visualNotes?: string;
  }[],
): string {
  const planMap = new Map(visualPlan.map((p) => [p.sceneId, p]));
  return JSON.stringify(
    scenes.map((s) => {
      const plan = planMap.get(s.sceneId);
      return {
        sceneId: s.sceneId,
        renderStyle: plan?.renderStyle,
        colorMood: plan?.colorMood,
        lighting: plan?.lighting,
        composition: plan?.composition,
        visualNotes: plan?.visualNotes,
      };
    }),
    null,
    2,
  );
}

function sceneResultsFromPrediction(
  prediction: QaPrediction,
  sceneIds: number[],
): SceneResult[] {
  return sceneIds.map((sceneId) => {
    const raw = prediction.sceneVerdicts?.[sceneId];
    return {
      sceneId,
      verdict: raw === "revise" ? "revise" : "pass",
    };
  });
}

function revisionTargetFromPrediction(
  prediction: QaPrediction,
  status: string,
): PromptQAOutput["revisionTarget"] {
  if (status === "approved") return "none";
  const raw = prediction.revisionTarget;
  if (raw === "prompts" || raw === "visual_plan" || raw === "both") {
    return raw;
  }
  return undefined;
}

export async function promptQANode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: { scenes: Scene[]; promptQA?: PromptQAOutput };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const scenes = state.production?.scenes ?? [];
  const visualPlan = state.production?.visualPlan ?? [];
  const videoProfile: VideoProfileConfig =
    state.videoProfile ?? resolveVideoProfile({});
  const audienceTrigger = state.storyPlan?.audienceTrigger?.type ?? "";
  const audienceTriggerStatement =
    state.storyPlan?.audienceTrigger?.statement ?? "";
  const audienceTriggerFactIds =
    state.storyPlan?.audienceTrigger?.factIds?.join(", ") ?? "";
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount = (state.execution?.retryCount?.PromptQA ?? 0) + 1;
  const execution = (currentNode: string) => ({
    currentNode,
    retryCount: { ...state.execution?.retryCount, PromptQA: retryCount },
  });

  if (!configUtils.enablePromptQA()) {
    return {
      production: {
        scenes,
        promptQA: { status: "approved", sceneResults: [] },
      },
      diagnostics: {},
      execution: {},
    };
  }

  if (scenes.length === 0 || !scenes.some((s) => s.generationPrompt)) {
    return {
      production: { scenes },
      diagnostics: {
        errors: [
          `${AgentModel.PromptQA}: No scenes with generation prompts to review`,
        ],
      },
      execution: execution(AgentModel.PromptQA),
    };
  }

  const canvasGuidance = canvasGuidanceFor(videoProfile);

  const label = nodeLabel(AgentModel.PromptQA);
  logger.nodeStart(label);
  logger.nodePhase(label, "reviewing scene prompts");

  const gateState = buildGateState("promptqa", state);
  const classified = gateState
    ? await tryClassifyQaGate("promptqa", {
        state: gateState.state,
        sceneIds: gateState.sceneIds,
        agent: AgentModel.PromptQA,
        inject: injectFromConfigurable(
          (config.configurable ?? {}) as Record<string, unknown>,
        ),
        promptVersion: PromptPaths.PromptQA.replace(/\.md$/, ""),
      })
    : null;

  if (classified && classified.prediction.status === "approved") {
    const sceneResults = sceneResultsFromPrediction(
      classified.prediction,
      gateState?.sceneIds ?? scenes.map((s) => s.sceneId),
    );
    logger.nodeDone(label, classified.telemetry.durationMs);
    return {
      production: {
        scenes,
        promptQA: {
          status: "approved",
          sceneResults,
          revisionTarget: "none",
        },
      },
      diagnostics: {
        telemetry: { [AgentModel.PromptQA]: classified.telemetry },
      },
      execution: execution(AgentModel.PromptQA),
    };
  }

  const result = await runAgent<PromptQAOutput>({
    agent: AgentModel.PromptQA,
    promptPath: PromptPaths.PromptQA,
    schema: PromptQAOutputSchema,
    variables: {
      scenes: formatScenes(scenes),
      visualPlan: formatVisualPlan(scenes, visualPlan),
      audienceTrigger,
      audienceTriggerStatement,
      audienceTriggerFactIds,
      formatGuidance: canvasGuidance.formatGuidance,
    },
    inject,
    configurable: withTopic(config, state).configurable,
    generateOptions: {
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    if (classified && classified.prediction.status !== "approved") {
      const sceneResults = sceneResultsFromPrediction(
        classified.prediction,
        gateState?.sceneIds ?? scenes.map((s) => s.sceneId),
      );
      logger.nodeDone(label, classified.telemetry.durationMs);
      return {
        production: {
          scenes,
          promptQA: {
            status: classified.prediction.status as PromptQAOutput["status"],
            globalFeedback: `Prompt QA (classifier): ${classified.prediction.status}`,
            issues: [result.error ?? "LLM call failed"],
            sceneResults,
            revisionTarget: revisionTargetFromPrediction(
              classified.prediction,
              classified.prediction.status,
            ),
          },
        },
        diagnostics: {
          telemetry: { [AgentModel.PromptQA]: classified.telemetry },
        },
        execution: execution(AgentModel.PromptQA),
      };
    }
    // QA infra failure (not a content verdict): signal the router to retry
    // this cheap QA node instead of regenerating prompts.
    logger.nodeFailed(label, result.error ?? "LLM call failed");
    return {
      production: {
        scenes,
        promptQA: {
          status: "retry",
          globalFeedback: `Prompt QA: ${result.error}`,
          issues: [result.error ?? "LLM call failed"],
          sceneResults: [],
        },
      },
      diagnostics: {
        telemetry: { [AgentModel.PromptQA]: result.telemetry },
      },
      execution: execution(AgentModel.PromptQA),
    };
  }

  logger.nodeDone(label, result.telemetry.durationMs);

  let qa = result.data;
  if (classified && classified.prediction.status !== "approved") {
    const sceneResults =
      classified.prediction.sceneVerdicts && gateState?.sceneIds
        ? sceneResultsFromPrediction(classified.prediction, gateState.sceneIds)
        : qa.sceneResults;
    qa = {
      ...qa,
      status: classified.prediction.status as PromptQAOutput["status"],
      sceneResults,
      revisionTarget:
        revisionTargetFromPrediction(
          classified.prediction,
          classified.prediction.status,
        ) ?? qa.revisionTarget,
    };
  }

  const expectedIds = new Set(scenes.map((s) => s.sceneId));
  const returnedIds = new Set(qa.sceneResults.map((r) => r.sceneId));
  const missingIds = [...expectedIds].filter((id) => !returnedIds.has(id));
  const extraIds = [...returnedIds].filter((id) => !expectedIds.has(id));
  const errors: string[] = [];

  if (missingIds.length > 0) {
    errors.push(
      `${AgentModel.PromptQA}: Missing results for scenes: [${missingIds.join(", ")}]`,
    );
  }
  if (extraIds.length > 0) {
    errors.push(
      `${AgentModel.PromptQA}: Extra results for unknown scenes: [${extraIds.join(", ")}]`,
    );
  }

  if (errors.length > 0) {
    // A partial scene-result set is a fixable LLM omission: route back to the
    // image prompt generator as a minor revision with explicit feedback.
    return {
      production: {
        scenes,
        promptQA: {
          status: "minor_revision",
          globalFeedback: `Scene coverage mismatch: ${errors.join("; ")}. Review the prompts for the listed scenes and return a complete set.`,
          issues: errors,
          sceneResults: qa.sceneResults,
        },
      },
      diagnostics: {
        warnings: errors,
        telemetry: { [AgentModel.PromptQA]: result.telemetry },
      },
      execution: execution(AgentModel.PromptQA),
    };
  }

  const isRevision =
    qa.status === "minor_revision" ||
    qa.status === "major_revision" ||
    qa.status === "fatal";
  const feedbackHash = hashIssues(qa.issues, qa.globalFeedback);
  const previousHash = state.execution?.qaFeedback?.[AgentModel.PromptQA];
  const repeated = isRevision && previousHash === feedbackHash;

  const qaOutput: PromptQAOutput = repeated ? { ...qa, repeated: true } : qa;

  return {
    production: {
      scenes,
      promptQA: qaOutput,
    },
    diagnostics: {
      ...(qa.status === "fatal"
        ? {
            errors: [
              `${AgentModel.PromptQA}: ${qa.globalFeedback ?? "scene prompts are unusable"}`,
            ],
          }
        : {}),
      telemetry: { [AgentModel.PromptQA]: result.telemetry },
    },
    execution: {
      currentNode: AgentModel.PromptQA,
      retryCount: { ...state.execution?.retryCount, PromptQA: retryCount },
      ...(isRevision
        ? {
            qaFeedback: {
              ...state.execution?.qaFeedback,
              [AgentModel.PromptQA]: feedbackHash,
            },
          }
        : {}),
    },
  };
}
