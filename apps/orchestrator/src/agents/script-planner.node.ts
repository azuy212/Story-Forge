import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Content,
  Diagnostics,
  Execution,
  VideoProfileConfig,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import {
  scriptPlannerOutputSchema,
  beatCountRangeFor,
} from "../schemas/script-planner-output.js";
import type { ScriptPlannerOutput } from "../schemas/script-planner-output.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import {
  formatLabelFor,
  canvasGuidanceFor,
  wordRangeFor,
  speakingRateWordsPerSecond,
  resolveVideoProfile,
} from "../utils/video-profile.js";

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

function emptyStoryPlan(): ScriptPlannerOutput {
  return {
    content: { title: "", hook: "" },
    storyType: "mystery",
    storySummary: "",
    storyBeats: [],
    audienceTrigger: { type: "curiosity", statement: "", factIds: [] },
    endingType: "revelation",
    retention: { pivotBeatId: 1 },
  };
}

function validateStoryPlan(
  data: ScriptPlannerOutput,
  approvedFactIds: string[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // beatId contiguity, exact duration sums, the final/non-final
  // curiosityQuestion contract, trigger-fact consistency, and the targetWords
  // total are enforced by the schema (deterministic structural invariants);
  // the composer normalizes timing anyway. Only semantic checks against the
  // APPROVED fact set are kept here — and references code cannot repair are
  // hard failures: a plan that cites unapproved facts cannot produce a
  // faithful script, and the writer would inherit an untraceable claim.

  const referencedIds = new Set(
    data.storyBeats.flatMap((b) => b.referencedFacts),
  );
  const approvedSet = new Set(approvedFactIds);

  for (const rid of referencedIds) {
    if (!approvedSet.has(rid)) {
      errors.push(
        `StoryPlanner: beat references fact "${rid}" which is not in approved facts`,
      );
    }
  }

  const unusedIds = approvedFactIds.filter((id) => !referencedIds.has(id));
  if (unusedIds.length > 0) {
    warnings.push(
      `StoryPlanner: approved facts never referenced in any beat: [${unusedIds.join(", ")}]`,
    );
  }

  const triggerFactIds = new Set(data.audienceTrigger?.factIds ?? []);
  for (const rid of triggerFactIds) {
    if (!approvedSet.has(rid)) {
      errors.push(
        `StoryPlanner: audienceTrigger references fact "${rid}" which is not in approved facts`,
      );
    }
  }

  return { errors, warnings };
}

export async function scriptPlannerNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  content: Partial<Content>;
  storyPlan: ScriptPlannerOutput;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { pillar, topic } = state.project;
  const research = state.research;
  const channel = state.branding?.channel;
  const videoProfile: VideoProfileConfig =
    state.videoProfile ?? resolveVideoProfile({});
  const inject = (config.configurable ?? {}) as AgentInject;

  if (!research?.summary || !research?.facts || research.facts.length === 0) {
    return {
      content: {},
      storyPlan: emptyStoryPlan(),
      diagnostics: {
        errors: [
          `${AgentModel.ScriptPlanner}: research is required before script planning.`,
        ],
      },
      execution: { currentNode: AgentModel.ScriptPlanner },
    };
  }

  const targetDurationSec = videoProfile.targetDurationSec;
  const wordRange = wordRangeFor(videoProfile);
  const speakingRate = speakingRateWordsPerSecond(videoProfile);
  const formatLabel = formatLabelFor(videoProfile);
  const canvasGuidance = canvasGuidanceFor(videoProfile);
  const beatRange = beatCountRangeFor(videoProfile);
  const beatCountRange =
    beatRange.max === null
      ? `${beatRange.min}+`
      : `${beatRange.min}-${beatRange.max}`;

  const label = nodeLabel(AgentModel.ScriptPlanner);
  logger.nodeStart(label);
  logger.nodePhase(label, "building story structure");

  const result = await runAgent<ScriptPlannerOutput>({
    agent: AgentModel.ScriptPlanner,
    promptPath: PromptPaths.ScriptPlanner,
    schema: scriptPlannerOutputSchema(videoProfile),
    variables: {
      pillar: pillar ?? "",
      topic: topic ?? "",
      researchSummary: research.summary ?? "",
      approvedFacts: formatFacts(research.facts),
      channel: channel ?? "",
      estimatedDurationSeconds: String(targetDurationSec),
      targetDurationSeconds: String(targetDurationSec),
      formatLabel,
      canvasGuidance: canvasGuidance.canvasGuidance,
      targetWordRange: `${wordRange.min}-${wordRange.max}`,
      speakingRateWordsPerSecond: String(speakingRate),
      beatCountRange,
    },
    inject,
    configurable: withTopic(config, state).configurable,
    generateOptions: {
      temperature: 0.5,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    logger.nodeFailed(label, result.error ?? "Unknown LLM error");
    return {
      content: {},
      storyPlan: emptyStoryPlan(),
      diagnostics: {
        errors: [`${AgentModel.ScriptPlanner}: ${result.error}`],
        telemetry: { [AgentModel.ScriptPlanner]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ScriptPlanner },
    };
  }

  logger.nodeDone(label, result.telemetry.durationMs);

  const {
    content,
    storyType,
    storySummary,
    storyBeats,
    audienceTrigger,
    endingType,
    retention,
  } = result.data;

  const approvedFactIds = research.facts.map((f) => f.id);
  const { errors, warnings } = validateStoryPlan(result.data, approvedFactIds);

  if (errors.length > 0) {
    logger.nodeFailed(label, errors[0]);
    return {
      content: {},
      storyPlan: emptyStoryPlan(),
      diagnostics: {
        errors,
        telemetry: { [AgentModel.ScriptPlanner]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ScriptPlanner },
    };
  }

  return {
    content: { title: content.title.trim(), hook: content.hook.trim() },
    storyPlan: {
      content: { title: content.title.trim(), hook: content.hook.trim() },
      storyType,
      storySummary,
      storyBeats,
      audienceTrigger,
      endingType,
      retention,
    },
    diagnostics: {
      warnings,
      telemetry: { [AgentModel.ScriptPlanner]: result.telemetry },
    },
    execution: { currentNode: AgentModel.ScriptPlanner },
  };
}
