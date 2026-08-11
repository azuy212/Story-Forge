import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { VisualDirectorOutputSchema } from "../schemas/visual-director-output.js";
import type {
  VisualDirectorOutput,
  VisualPlanEntry,
} from "../schemas/visual-director-output.js";
import { logger } from "../utils/logger.js";

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

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function tokenize(s: string): string[] {
  return normalizeWhitespace(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function endsWithTokens(source: string, suffix: string): boolean {
  const sourceTokens = tokenize(source);
  const suffixTokens = tokenize(suffix);
  if (suffixTokens.length === 0 || suffixTokens.length > sourceTokens.length) {
    return false;
  }
  return suffixTokens.every(
    (word, index) =>
      sourceTokens[sourceTokens.length - suffixTokens.length + index] === word,
  );
}

/**
 * Fraction of `target` words found, in order, as a subsequence of `source`.
 * forward(source, concat) ~ 1 means nothing was dropped;
 * backward(source, concat) ~ 1 means nothing was added.
 */
function subsequenceCoverage(source: string[], target: string[]): number {
  if (target.length === 0) return 1;
  let index = 0;
  let matched = 0;
  for (const word of target) {
    while (index < source.length) {
      if (source[index] === word) {
        matched++;
        index++;
        break;
      }
      index++;
    }
  }
  return matched / target.length;
}

const COVERAGE_ACCEPT = 0.98;

function isRecoverableOutputError(error: string | undefined): boolean {
  return (
    error?.startsWith("Schema validation failed") === true ||
    error?.startsWith("Invalid JSON") === true ||
    error?.startsWith("Empty response") === true
  );
}

/**
 * Split the narration into `n` contiguous pieces whose word counts follow
 * `proportions`. The pieces cover the narration exactly (nothing dropped,
 * nothing added) — this is the deterministic repair for an LLM that
 * paraphrased, dropped, or padded words.
 */
function splitNarrationProportional(
  narration: string,
  proportions: number[],
): string[] {
  const total = proportions.reduce((a, b) => a + b, 0);
  if (total <= 0) return Array.from({ length: proportions.length }, () => "");
  const words = narration.match(/\S+\s*/g) ?? [];
  if (words.length === 0)
    return Array.from({ length: proportions.length }, () => "");

  const targets = Array.from({ length: proportions.length }, () => 0);
  let acc = 0;
  for (let i = 0; i < proportions.length; i++) {
    acc += proportions[i];
    targets[i] = (acc / total) * words.length;
  }

  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < proportions.length; i++) {
    const isLast = i === proportions.length - 1;
    let end = isLast
      ? words.length
      : Math.max(start + 1, Math.round(targets[i]));
    end = Math.min(words.length, Math.max(start + 1, end));
    parts.push(words.slice(start, end).join(""));
    start = end;
  }
  return parts;
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
  const wordCounts = segments.map((n) => tokenize(n).length);
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
 * (safe repair: a scene just cites less), and repair narration coverage by
 * re-segmenting the original narration in code when the LLM deviated.
 */
function normalizeOutput(
  data: VisualDirectorOutput,
  narration: string,
  validFactIds: Set<string>,
): NormalizedScenes {
  const warnings: string[] = [];

  // Reindex sceneIds to 1..N, keeping a map of old id -> new id so visual
  // plans (keyed by the LLM's original ids) can be renumbered to match.
  const oldToNew = new Map<number, number>();
  const reindexed = data.scenes.map((s, i) => {
    oldToNew.set(s.sceneId, i + 1);
    return {
      ...s,
      sceneId: i + 1,
      references: Array.from(new Set(s.references ?? [])),
    };
  });

  const originalTokens = tokenize(narration);
  const concatTokens = tokenize(reindexed.map((s) => s.narration).join(" "));
  const forward = subsequenceCoverage(originalTokens, concatTokens);
  const backward = subsequenceCoverage(concatTokens, originalTokens);

  let scenes = reindexed;
  if (forward < COVERAGE_ACCEPT || backward < COVERAGE_ACCEPT) {
    // The LLM paraphrased, dropped, or padded narration. Repair deterministically:
    // re-split the original narration proportionally to the LLM's segment sizes.
    const proportions = reindexed.map((s) => tokenize(s.narration).length);
    const repaired = splitNarrationProportional(narration, proportions);
    scenes = reindexed.map((s, i) => ({ ...s, narration: repaired[i] }));
    warnings.push(
      `VisualDirector: narration re-segmented in code (coverage forward=${(forward * 100).toFixed(1)}%, backward=${(backward * 100).toFixed(1)}%)`,
    );
  }

  // Drop references to fact IDs that do not exist in approved facts. A scene
  // ending up with no references is acceptable (B-roll scenes).
  const filtered = scenes.map((s) => {
    const known = s.references.filter((r) => validFactIds.has(r));
    const dropped = s.references.length - known.length;
    if (dropped > 0) {
      warnings.push(
        `VisualDirector: dropped ${dropped} hallucinated fact reference(s) in scene ${s.sceneId}`,
      );
    }
    return {
      ...s,
      references: known,
      entities: s.entities?.map((entity) => ({
        ...entity,
        requiresSourceImage:
          entity.requiresSourceImage || entity.type === "person",
      })),
    };
  });

  // Reindex visual plans against the renumbered scenes; drop extras.
  const newToOld = new Map<number, number>();
  for (const [oldId, newId] of oldToNew) newToOld.set(newId, oldId);
  const planByOldId = new Map(data.visualPlans.map((p) => [p.sceneId, p]));
  const visualPlans = filtered.flatMap((s) => {
    const oldId = newToOld.get(s.sceneId) ?? s.sceneId;
    const plan = planByOldId.get(oldId);
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

export async function visualDirectorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: {
    scenes: Scene[];
    visualPlan?: VisualPlanEntry[];
    directorReview?: {
      status: "approved" | "minor_revision";
      feedback: string;
    };
  };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { title, narration, estimatedDurationSeconds } = state.content ?? {};
  const ending = state.content?.ending;
  const researchSummary = state.research?.summary;
  const approvedFacts = state.research?.facts;
  const channel = state.branding?.channel;
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

  const result = await runAgent<VisualDirectorOutput>({
    agent: AgentModel.VisualDirector,
    promptPath: PromptPaths.VisualDirector,
    schema: VisualDirectorOutputSchema,
    variables: {
      title: title ?? "",
      narration: narration ?? "",
      endingNarration: ending?.narration ?? "",
      endingVisualDirection: ending?.visualDirection ?? "",
      estimatedDurationSeconds: String(estimatedDurationSeconds ?? 50),
      researchSummary: researchSummary ?? "",
      approvedFacts: formatFacts(approvedFacts),
      channel: channel ?? "",
      qaFeedback,
    },
    inject,
    configurable: config.configurable as Record<string, unknown>,
    generateOptions: {
      temperature: 0.5,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    const directorReview = isRecoverableOutputError(result.error)
      ? {
          status: "minor_revision" as const,
          feedback: `Previous VisualDirector output was rejected: ${result.error}. Return corrected JSON matching the exact schema and allowed enum values.`,
        }
      : undefined;
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

  const validFactIds = new Set(approvedFacts.map((f) => f.id));
  const {
    scenes: normalized,
    visualPlans,
    warnings,
  } = normalizeOutput(result.data, narration ?? "", validFactIds);

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

  const timed = computeTiming(
    normalized.map((s) => s.narration),
    estimatedDurationSeconds ?? 50,
  );

  if (
    ending &&
    (!endsWithTokens(normalized.at(-1)?.narration ?? "", ending.narration) ||
      !["payoff", "reflection"].includes(
        normalized.at(-1)?.emotionalBeat ?? "",
      ))
  ) {
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

  const scenes: Scene[] = normalized.map((s, i) => ({
    sceneId: s.sceneId,
    startSecond: timed[i].startSecond,
    endSecond: timed[i].endSecond,
    durationSeconds: timed[i].durationSeconds,
    narration: timed[i].narration,
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
    entities: s.entities,
    references: s.references,
  }));

  if (warnings.length > 0) {
    logger.warn(`${AgentModel.VisualDirector} normalized output`, { warnings });
  }

  return {
    production: {
      scenes,
      visualPlan: visualPlans,
      directorReview: { status: "approved", feedback: "" },
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
