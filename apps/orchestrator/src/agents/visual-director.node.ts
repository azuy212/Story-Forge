import {
  resolveVideoProfile,
  formatLabelFor,
  canvasGuidanceFor,
  speakingRateWordsPerSecond,
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
import {
  sceneCountBand,
  visualDirectorSalvageSchema,
  visualDirectorUnitOutputSchema,
} from "../schemas/visual-director-output.js";
import type {
  VisualDirectorOutput,
  VisualDirectorUnitOutput,
  VisualPlanEntry,
} from "../schemas/visual-director-output.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import { MINOR_REVISION_MAX } from "../utils/constants.js";
import {
  buildNarrationUnits,
  finalizeSceneUnits,
  formatUnits,
  UNIT_PIPELINE_VERSION,
} from "../utils/scene-units.js";
import { endsWithTokens, wordCount } from "../utils/narration-contract.js";

function formatFacts(
  facts: {
    id: string;
    fact: string;
    confidence: string;
    classification?: string;
  }[],
): string {
  return facts
    .map((f) => {
      const cls = f.classification ? ` (${f.classification})` : "";
      return `- ${f.id}${cls} (${f.confidence}): ${f.fact}`;
    })
    .join("\n");
}

/**
 * The planner's beats (id + key message) so the director can map scenes back
 * to story beats via `sourceBeatIds` instead of silently dropping a beat when
 * merging scenes.
 */
function serializeStoryBeats(
  beats:
    { beatId: number; keyMessage: string; opensLoop?: string }[] | undefined,
): string {
  if (!beats || beats.length === 0) return "";
  return beats
    .map((beat) => {
      const loop = beat.opensLoop ? ` — opens loop: ${beat.opensLoop}` : "";
      return `Beat ${beat.beatId}: ${beat.keyMessage}${loop}`;
    })
    .join("\n");
}

/**
 * Re-validate a schema-rejected payload against the relaxed salvage schema.
 *
 * Returns undefined when there is nothing to recover or the payload is not a
 * structurally sound storyboard. Never throws: recovery is best-effort, so the
 * caller still has its normal failure paths available. The recovered scenes
 * still speak in unit ids — the caller runs them through the same
 * `finalizeSceneUnits` repair/derive path used for cleanly validated responses.
 */
function salvageRejectedOutput(
  rejected: unknown,
): VisualDirectorUnitOutput | undefined {
  if (rejected == null) return undefined;
  const parsed = visualDirectorSalvageSchema().safeParse(rejected);
  if (!parsed.success) return undefined;
  return parsed.data;
}

function isRecoverableOutputError(error: string | undefined): boolean {
  return (
    error?.startsWith("Schema validation failed") === true ||
    error?.startsWith("Invalid JSON") === true ||
    error?.startsWith("Empty response") === true
  );
}

/**
 * Compute scene timestamps from narration word counts: each scene gets a
 * duration proportional to its share of the total words, starting at 0 and
 * contiguous. This replaces LLM-computed arithmetic (which the composer
 * rescales to the real narration duration anyway).
 */
function computeTiming(
  segments: string[],
  totalSeconds: number,
): {
  startSecond: number;
  endSecond: number;
  durationSeconds: number;
  narration: string;
}[] {
  const wordCounts = segments.map((n) => wordCount(n));
  const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1;

  const durations = wordCounts.map((w) => (w / totalWords) * totalSeconds);
  const rounded = durations.map((d) => Math.round(d * 100) / 100);
  const sum = rounded.reduce((a, b) => a + b, 0);
  const drift = Math.round((totalSeconds - sum) * 100) / 100;
  if (rounded.length > 0) {
    rounded[rounded.length - 1] =
      Math.round((rounded[rounded.length - 1] + drift) * 100) / 100;
  }

  let cursor = 0;
  return segments.map((narration, i) => {
    const startSecond = Math.round(cursor * 100) / 100;
    cursor += rounded[i];
    const endSecond = Math.round(cursor * 100) / 100;
    return {
      startSecond,
      endSecond,
      durationSeconds: Math.round((endSecond - startSecond) * 100) / 100,
      narration: narration.trim(),
    };
  });
}

interface NormalizedScenes {
  scenes: VisualDirectorOutput["scenes"];
  visualPlans: VisualPlanEntry[];
  warnings: string[];
}

/**
 * Reindex sceneIds to 1..N, dedupe references, drop hallucinated fact IDs
 * (safe repair: a scene just cites less), and reindex visual plans to match.
 *
 * Unit coverage itself (scene boundaries, word caps, order, narration
 * derivation) was already validated and repaired by `finalizeSceneUnits` in
 * the post-process hook, so the narration here is final. What remains is
 * bookkeeping the post-process cannot do: scene ids must be renumbered onto
 * the repaired scene order, and visual plans must follow the scenes they
 * originally described through merges, splits, and drops.
 */
function normalizeOutput(
  data: VisualDirectorOutput,
  validFactIds: Set<string>,
  validBeatIds?: Set<number>,
): NormalizedScenes {
  const warnings: string[] = [];

  // `modelSceneIds` carries every model-origin scene id a final scene
  // represents (split pieces share their parent's id; a scene folded into a
  // neighbouring one inherits its id). Maps old id -> new id so visual plans
  // (keyed by the LLM's original ids) can be renumbered to match.
  const oldToNew = new Map<number, number>();
  /** Old model scene ids behind each renumbered scene, in origin order. */
  const originsByNew = new Map<number, number[]>();
  const reindexed = data.scenes.map((s, i) => {
    const originIds =
      s.modelSceneIds && s.modelSceneIds.length > 0
        ? s.modelSceneIds
        : [s.sceneId];
    originsByNew.set(i + 1, originIds);
    for (const oldId of originIds) {
      if (!oldToNew.has(oldId)) oldToNew.set(oldId, i + 1);
    }
    return {
      ...s,
      sceneId: i + 1,
      references: Array.from(new Set(s.references ?? [])),
    };
  });
  const scenes = reindexed;

  // Drop references to fact IDs that do not exist in approved facts. A scene
  // ending up with no references is acceptable (B-roll scenes). Scene→beat
  // traceability gets the same treatment: an unknown beatId is dropped rather
  // than hallucinated into the production plan.
  const filtered = scenes.map((s) => {
    const known = s.references.filter((r) => validFactIds.has(r));
    const dropped = s.references.length - known.length;
    if (dropped > 0) {
      warnings.push(
        `VisualDirector: dropped ${dropped} hallucinated fact reference(s) in scene ${s.sceneId}`,
      );
    }
    const beatIds = validBeatIds
      ? s.sourceBeatIds?.filter((id) => validBeatIds.has(id))
      : s.sourceBeatIds;
    const droppedBeats =
      (s.sourceBeatIds?.length ?? 0) - (beatIds?.length ?? 0);
    if (droppedBeats > 0) {
      warnings.push(
        `VisualDirector: dropped ${droppedBeats} unknown source beat reference(s) in scene ${s.sceneId}`,
      );
    }
    return {
      ...s,
      references: known,
      sourceBeatIds: beatIds,
      entities: s.entities?.map((entity) => ({
        ...entity,
        requiresSourceImage:
          entity.requiresSourceImage || entity.type === "person",
      })),
    };
  });

  // Reindex visual plans against the renumbered scenes; drop extras. Split
  // pieces of one model scene share that scene's plan (the pieces inherit its
  // visual direction); for a merged scene the WINNING scene's plan runs the
  // visual direction — foldSceneInto puts the winner's model scene id first
  // in modelSceneIds, so the first origin is the winner.
  const planByOldId = new Map(data.visualPlans.map((p) => [p.sceneId, p]));
  const visualPlans = filtered.flatMap((s) => {
    const originIds = originsByNew.get(s.sceneId) ?? [];
    const plan = originIds
      .map((oldId) => planByOldId.get(oldId))
      .find((candidate) => candidate !== undefined);
    if (!plan) return [];
    return [{ ...plan, sceneId: s.sceneId }];
  });
  // "Extra" plans are those keyed by ids that matched no scene — plans that
  // were consumed under their renumbered ids are not extras.
  const knownOldIds = new Set(oldToNew.keys());
  const extraPlans = data.visualPlans.filter(
    (p) => !knownOldIds.has(p.sceneId),
  );
  if (extraPlans.length > 0) {
    warnings.push(
      `VisualDirector: dropped visual plans for unknown scenes: [${extraPlans.map((p) => p.sceneId).join(", ")}]`,
    );
  }

  return { scenes: filtered, visualPlans, warnings };
}

/**
 * The revision baseline must carry the continuity fields the scene rules are
 * judged on. A revision prompted only with visual descriptions silently drops
 * `visualAnchor`, `transition`, `emphasis`, and `sourceBeatIds`, which is
 * exactly the anchor-identity and beat-coverage loss the rules exist to stop.
 */
function serializePreviousVisualPlan(
  scenes: Scene[],
  visualPlan: VisualPlanEntry[],
): string {
  const planMap = new Map(visualPlan.map((p) => [p.sceneId, p]));
  return JSON.stringify(
    scenes.map((s) => {
      const plan = planMap.get(s.sceneId);
      return {
        sceneId: s.sceneId,
        sceneType: s.sceneType,
        assetMode: s.assetMode ?? "generated",
        sceneRole: s.sceneRole,
        visualDescription: s.visualDescription,
        narration: s.narration,
        visualAnchor: s.visualAnchor,
        sourceBeatIds: s.sourceBeatIds,
        transition: s.transition,
        emphasis: s.emphasis,
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

export async function visualDirectorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: {
    scenes: Scene[];
    visualPlan?: VisualPlanEntry[];
    directorReview?: {
      status: "approved" | "minor_revision" | "major_revision";
      feedback: string;
    };
  };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { title, narration } = state.content ?? {};
  const ending = state.content?.ending;
  const content = state.content;
  const researchSummary = state.research?.summary;
  const approvedFacts = state.research?.facts;
  const channel = state.branding?.channel;
  const storyPlan = state.storyPlan;
  const videoProfile: VideoProfileConfig =
    state.videoProfile ?? resolveVideoProfile({});
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount = (state.execution?.retryCount?.VisualDirector ?? 0) + 1;

  if (!researchSummary || !approvedFacts || approvedFacts.length === 0) {
    return {
      production: { scenes: [] },
      diagnostics: {
        errors: [
          `${AgentModel.VisualDirector}: research is required before storyboard planning.`,
        ],
      },
      execution: {
        currentNode: AgentModel.VisualDirector,
        retryCount: {
          ...state.execution?.retryCount,
          VisualDirector: retryCount,
        },
      },
    };
  }

  // Feedback sources: PromptQA major_revision (root cause in the visual plan)
  // or this node's own previous directorReview (validation failure).
  const promptQA = state.production?.promptQA;
  const directorReview = state.production?.directorReview;
  // A directorReview minor_revision is newer than PromptQA major_revision:
  // PromptQA only runs after VisualDirector succeeds, while this review is
  // written by a later structural validation failure in VisualDirector.
  const qaFeedback =
    directorReview?.status === "minor_revision"
      ? directorReview.feedback
      : promptQA?.status === "major_revision"
        ? [
            ...(promptQA.globalFeedback
              ? [`Feedback: ${promptQA.globalFeedback}`]
              : []),
            ...(promptQA.issues?.length
              ? [`Issues:\n${promptQA.issues.map((i) => `- ${i}`).join("\n")}`]
              : []),
          ].join("\n")
        : "";

  const needsRevision =
    directorReview?.status === "minor_revision" ||
    promptQA?.status === "major_revision";

  // Snapshot the previous scenes/visual plan from state BEFORE any destructive
  // handling in this run so a revision re-prompt can see (and modify) what it
  // produced previously rather than regenerating from scratch. Only populated
  // when a revision was requested.
  const previousVisualPlan = needsRevision
    ? serializePreviousVisualPlan(
        state.production?.scenes ?? [],
        state.production?.visualPlan ?? [],
      )
    : "";

  const targetDurationSec = videoProfile.targetDurationSec;
  const formatLabel = formatLabelFor(videoProfile);
  const canvasGuidance = canvasGuidanceFor(videoProfile);
  const speakingRate = speakingRateWordsPerSecond(videoProfile);
  const sceneCountRange =
    videoProfile.sceneDensity.max === null
      ? `${videoProfile.sceneDensity.min}+`
      : `${videoProfile.sceneDensity.min}-${videoProfile.sceneDensity.max}`;

  // Target scene count: aim for middle of density range (long profile has no max)
  const effectiveMax =
    videoProfile.sceneDensity.max ?? videoProfile.sceneDensity.min * 2;
  const targetSceneCount = Math.round(
    (videoProfile.sceneDensity.min + effectiveMax) / 2,
  );

  // Hard narration budget for a single scene (~6 seconds of speech). The
  // ~75 words / 6s figure in older prompts was internally inconsistent.
  const maxSceneWords = Math.floor(speakingRate * 6);

  // Pre-segment the narration into units the model groups by id. The model
  // never sees narration it could reword — scenes only reference unit ids, so
  // the derived narration cannot drift from the narration itself.
  const units = buildNarrationUnits(narration ?? "", maxSceneWords);
  const band = sceneCountBand(videoProfile);

  const label = nodeLabel(AgentModel.VisualDirector);
  logger.nodeStart(label);
  logger.nodePhase(label, "planning visual direction");

  // Repair warnings and unit telemetry produced inside the harness post-process.
  // `compute` (and with it `postProcess`) runs strictly within the awaited
  // `runAgent` call below, so these closure stores are fully populated before
  // the node reads them.
  const unitWarnings: string[] = [];

  /**
   * Validate the model's unit grouping, repair what is repairable
   * deterministically, and derive scene narrations. A returned string is the
   * specific problem fed back to the model through the harness retry loop —
   * the model is only re-asked when repair is impossible.
   */
  const finalizeSceneOutput = (
    raw: VisualDirectorUnitOutput,
    bandOverride?: { minScenes: number; maxScenes: number | null },
    recovering = false,
  ):
    | { data: VisualDirectorOutput; metaExtras: Record<string, unknown> }
    | string => {
    const finalized = finalizeSceneUnits(raw.scenes, units, {
      maxSceneWords,
      // No `??` on maxScenes: an explicit `null` (unbounded salvage band) must
      // override the profile band, and `null ?? band` would coalesce back.
      minScenes: bandOverride ? bandOverride.minScenes : band.minScenes,
      maxScenes: bandOverride ? bandOverride.maxScenes : band.maxScenes,
      endingNarration: ending?.narration,
      pivotSentence: content?.retention?.pivotSentence,
      recovering,
    });
    if (finalized.issues.length > 0) {
      return `scene units: ${finalized.issues.join("; ")}`;
    }
    unitWarnings.push(...finalized.warnings);
    return {
      data: { ...raw, scenes: finalized.scenes } as VisualDirectorOutput,
      metaExtras: {
        unitCount: finalized.unitCount,
        repairRan: finalized.repairRan,
      },
    };
  };

  const result = await runAgent<VisualDirectorUnitOutput, VisualDirectorOutput>(
    {
      agent: AgentModel.VisualDirector,
      promptPath: PromptPaths.VisualDirector,
      // The model speaks unit ids (no narration field); the post-process derives
      // the narration the next stage of this node consumes.
      schema: visualDirectorUnitOutputSchema(videoProfile),
      postProcess: (data) => finalizeSceneOutput(data),
      // The unit pipeline (splitter + deterministic repair) shapes the stored
      // storyboard; bumping it must invalidate cached artifacts.
      codeVersion: UNIT_PIPELINE_VERSION,
      variables: {
        title: title ?? "",
        narration: narration ?? "",
        narrationUnits: formatUnits(units),
        endingNarration: ending?.narration ?? "",
        endingVisualDirection: ending?.visualDirection ?? "",
        estimatedDurationSeconds: String(targetDurationSec),
        researchSummary: researchSummary ?? "",
        approvedFacts: formatFacts(approvedFacts),
        channel: channel ?? "",
        qaFeedback,
        previousVisualPlan,
        formatLabel,
        canvasGuidance: canvasGuidance.canvasGuidance,
        aspectGuidance: canvasGuidance.aspectGuidance,
        targetDurationSeconds: String(targetDurationSec),
        speakingRateWordsPerSecond: String(speakingRate),
        maxSceneWords: String(maxSceneWords),
        sceneCountRange,
        targetSceneCount: String(targetSceneCount),
        audienceTrigger: state.storyPlan?.audienceTrigger?.type ?? "",
        audienceTriggerStatement:
          state.storyPlan?.audienceTrigger?.statement ?? "",
        audienceTriggerFactIds:
          state.storyPlan?.audienceTrigger?.factIds?.join(", ") ?? "",
        endingType: storyPlan?.endingType ?? "",
        pivotSentence: state.content?.retention?.pivotSentence ?? "",
        pivotBeatId: String(storyPlan?.retention?.pivotBeatId ?? ""),
        storyBeats: serializeStoryBeats(storyPlan?.storyBeats),
      },
      inject,
      configurable: withTopic(config, state).configurable,
      generateOptions: {
        temperature: 0.5,
        responseFormat: { type: "json_object" },
      },
    },
  );

  // A rejected payload can still be a structurally sound storyboard that only
  // missed the strict scene-count band. Recover it before giving up so the
  // router has a real "best available result" to accept once its minor
  // revision budget is spent — without this, an exhausted budget means no
  // scenes at all and the run ends.
  const salvaged =
    result.data == null ? salvageRejectedOutput(result.rejected) : undefined;

  if ((result.error || !result.data) && !salvaged) {
    const directorReview = isRecoverableOutputError(result.error)
      ? {
          status: "minor_revision" as const,
          feedback: `Previous VisualDirector output was rejected: ${result.error}. Return corrected JSON matching the exact schema and allowed enum values.`,
        }
      : undefined;
    logger.nodeFailed(label, result.error ?? "Unknown LLM error");
    return {
      production: {
        scenes: [],
        ...(directorReview ? { directorReview } : {}),
      },
      diagnostics: {
        errors: [`${AgentModel.VisualDirector}: ${result.error}`],
        telemetry: { [AgentModel.VisualDirector]: result.telemetry },
      },
      execution: {
        currentNode: AgentModel.VisualDirector,
        retryCount: {
          ...state.execution?.retryCount,
          VisualDirector: retryCount,
        },
      },
    };
  }

  const recovered = result.data == null;
  let sceneOutput: VisualDirectorOutput;
  if (result.data) {
    sceneOutput = result.data;
  } else if (salvaged) {
    logger.nodeRecovered(
      label,
      `${result.error} — accepted the rejected payload after re-validating it ` +
        `against the relaxed salvage schema`,
    );
    // The salvage schema relaxes only the scene-count band. The unit contract
    // (coverage, caps, order, narration derivation) still runs through the
    // same finalize path — a unit failure there is a content failure, not a
    // band problem, so nothing further is recoverable by relaxing again.
    // Recovered repairs may skip (not veto): a protected scene simply blocks
    // its ending absorb and the ending contract is warning-downgraded below.
    const outcome = finalizeSceneOutput(
      salvaged,
      {
        minScenes: 1,
        maxScenes: null,
      },
      true,
    );
    if (typeof outcome === "string") {
      const feedback = `Previous VisualDirector output was rejected: ${result.error}. Salvage re-validation failed: ${outcome}`;
      logger.nodeFailed(label, feedback);
      return {
        production: {
          scenes: [],
          directorReview: { status: "minor_revision", feedback },
        },
        diagnostics: {
          errors: [`${AgentModel.VisualDirector}: ${feedback}`],
          warnings: unitWarnings,
          telemetry: { [AgentModel.VisualDirector]: result.telemetry },
        },
        execution: {
          currentNode: AgentModel.VisualDirector,
          retryCount: {
            ...state.execution?.retryCount,
            VisualDirector: retryCount,
          },
        },
      };
    }
    sceneOutput = outcome.data;
  } else {
    // Unreachable: the failure branch above returned when neither a validated
    // payload nor a salvage candidate exists.
    sceneOutput = { scenes: [], visualPlans: [] };
  }

  logger.nodeDone(label, result.telemetry.durationMs);

  const validFactIds = new Set(approvedFacts.map((f) => f.id));
  const validBeatIds = new Set(
    (state.storyPlan?.storyBeats ?? []).map((beat) => beat.beatId),
  );
  const normalizedOutput = normalizeOutput(
    sceneOutput,
    validFactIds,
    validBeatIds.size > 0 ? validBeatIds : undefined,
  );
  const { scenes: normalized, visualPlans } = normalizedOutput;
  let { warnings } = normalizedOutput;
  warnings.push(...unitWarnings);

  // Hard structural failure: visual plan coverage is not repairable in code.
  // Surface a minor_revision so the router retries VisualDirector with
  // feedback instead of silently ending the pipeline.
  const expectedIds = new Set(normalized.map((s) => s.sceneId));
  const planIds = new Set(visualPlans.map((p) => p.sceneId));
  const missingPlanIds = [...expectedIds].filter((id) => !planIds.has(id));
  if (normalized.length === 0 || missingPlanIds.length > 0) {
    const feedback =
      normalized.length === 0
        ? "No scenes were produced."
        : `Visual plans missing for scenes: [${missingPlanIds.join(", ")}]. Provide exactly one visual plan entry per scene.`;
    return {
      production: {
        scenes: [],
        directorReview: { status: "minor_revision", feedback },
      },
      diagnostics: {
        errors: [`${AgentModel.VisualDirector}: ${feedback}`],
        warnings,
        telemetry: { [AgentModel.VisualDirector]: result.telemetry },
      },
      execution: {
        currentNode: AgentModel.VisualDirector,
        retryCount: {
          ...state.execution?.retryCount,
          VisualDirector: retryCount,
        },
      },
    };
  }

  // A recovered payload exists to finish a run that would otherwise die, so it
  // must not re-introduce a veto. These two content contracts stay hard failures
  // for a cleanly validated response; on a recovered one they are downgraded to
  // warnings, because rejecting again would discard the only usable storyboard
  // and leave the minor-revision "accept best available" path with nothing.
  const acceptedAnywayWarnings = (
    feedback: string,
    reason: string,
  ): string[] => [
    ...warnings,
    `${AgentModel.VisualDirector}: ${feedback} (accepted anyway — ${reason})`,
  ];
  const recoveredWarnings = (feedback: string): string[] =>
    acceptedAnywayWarnings(
      feedback,
      "storyboard was recovered from a rejected response",
    );

  // The router's minor-revision budget allows MINOR_REVISION_MAX revisions on
  // top of the initial run, so once this run is the last affordable one there is
  // no retry left to resolve a content contract. Rejecting then would hand the
  // router an empty storyboard and make its "accept best available result"
  // decision vacuous — the run dies holding a complete plan it chose to discard.
  const lastAffordableRun = retryCount >= MINOR_REVISION_MAX + 1;

  // Narrative scenes must stay grounded in approved research. Normalization
  // only drops hallucinated IDs (never adds), so a narrative scene that ends
  // up with zero references is a structural failure — its narration cannot be
  // traced to a fact. B-roll scenes may legitimately have no references.
  const ungroundedNarrative = normalized.filter(
    (s) => s.sceneRole === "narrative" && (s.references ?? []).length === 0,
  );
  if (ungroundedNarrative.length > 0 && !recovered) {
    const feedback = `Narrative scene(s) [${ungroundedNarrative
      .map((s) => s.sceneId)
      .join(
        ", ",
      )}] must reference at least one approved fact; B-roll scenes are the only ones allowed to have no references.`;
    return {
      production: {
        scenes: [],
        directorReview: { status: "major_revision", feedback },
      },
      diagnostics: {
        errors: [`${AgentModel.VisualDirector}: ${feedback}`],
        warnings,
        telemetry: { [AgentModel.VisualDirector]: result.telemetry },
      },
      execution: {
        currentNode: AgentModel.VisualDirector,
        retryCount: {
          ...state.execution?.retryCount,
          VisualDirector: retryCount,
        },
      },
    };
  }
  if (ungroundedNarrative.length > 0) {
    warnings = recoveredWarnings(
      `ungrounded narrative scene(s) [${ungroundedNarrative
        .map((s) => s.sceneId)
        .join(", ")}]`,
    );
  }

  const timed = computeTiming(
    normalized.map((s) => s.narration),
    targetDurationSec,
  );

  const endingViolation =
    ending &&
    (!endsWithTokens(normalized.at(-1)?.narration ?? "", ending.narration) ||
      !["payoff", "reflection"].includes(
        normalized.at(-1)?.emotionalBeat ?? "",
      ));

  if (endingViolation && !recovered && !lastAffordableRun) {
    const feedback =
      "Final visual scene must contain exact narrative ending and use emotionalBeat payoff or reflection.";
    return {
      production: {
        scenes: [],
        directorReview: { status: "minor_revision", feedback },
      },
      diagnostics: {
        errors: [`${AgentModel.VisualDirector}: ${feedback}`],
        warnings,
        telemetry: { [AgentModel.VisualDirector]: result.telemetry },
      },
      execution: {
        currentNode: AgentModel.VisualDirector,
        retryCount: {
          ...state.execution?.retryCount,
          VisualDirector: retryCount,
        },
      },
    };
  }
  if (endingViolation) {
    warnings = acceptedAnywayWarnings(
      recovered
        ? "final scene does not satisfy the ending contract"
        : "final scene does not satisfy the ending contract and no revision budget remains",
      recovered
        ? "storyboard was recovered from a rejected response"
        : "discarding it would leave the run with no storyboard at all",
    );
  }

  const scenes: Scene[] = normalized.map((s, i) => ({
    sceneId: s.sceneId,
    startSecond: timed[i].startSecond,
    endSecond: timed[i].endSecond,
    durationSeconds: timed[i].durationSeconds,
    narration: timed[i].narration,
    unitIds: s.unitIds,
    sceneGoal: s.sceneGoal.trim(),
    visualDescription: s.visualDescription.trim(),
    sceneType: s.sceneType,
    cameraShot: s.cameraShot,
    cameraMotion: s.cameraMotion,
    transition: s.transition,
    emphasis: s.emphasis,
    emotionalBeat: s.emotionalBeat,
    assetType: s.assetType ?? "image",
    assetMode: s.assetMode,
    sceneRole: s.sceneRole,
    visualAnchor: s.visualAnchor,
    entities: s.entities,
    references: s.references,
    sourceBeatIds: s.sourceBeatIds,
  }));

  if (warnings.length > 0) {
    logger.warn(`${AgentModel.VisualDirector} normalized output`, { warnings });
  }

  return {
    production: {
      scenes,
      visualPlan: visualPlans,
      // A recovered storyboard is reported as a minor revision rather than
      // approved: it is usable, but QA downstream (and any later VisualDirector
      // re-entry) should know it came from a rejected response. Same for one
      // accepted with an unmet content contract — the scenes are kept, the
      // defect is still recorded, and `hasScenes` is what advances the graph.
      directorReview: recovered
        ? {
            status: "minor_revision",
            feedback:
              "Storyboard recovered from a schema-rejected response; scene count and visual direction may not match the requested format.",
          }
        : endingViolation
          ? {
              status: "minor_revision",
              feedback:
                "Storyboard accepted with no revision budget left; the final scene does not satisfy the ending contract.",
            }
          : { status: "approved", feedback: "" },
    },
    diagnostics: {
      warnings,
      telemetry: { [AgentModel.VisualDirector]: result.telemetry },
    },
    execution: {
      currentNode: AgentModel.VisualDirector,
      retryCount: {
        ...state.execution?.retryCount,
        VisualDirector: retryCount,
      },
    },
  };
}
