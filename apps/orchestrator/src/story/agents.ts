import { runAgent, type AgentInject } from "../agents/run-agent.js";
import { AgentModel } from "../models/agent-model.js";
import { promptPathsFor } from "../models/prompt-paths.js";
import { storyStyleLimits, type StoryStyleLimits } from "./lint.js";
import {
  CharacterRegistrySchema,
  SceneGroupingSchema,
  SceneVisualSlotsSchema,
  StoryOutputSchema,
  StoryVerificationSchema,
} from "./types.js";
import type {
  CharacterRegistry,
  SceneGrouping,
  SceneVisualSlots,
  StoryClaim,
  StoryOutput,
  StoryVerification,
} from "./types.js";

/**
 * The story pipeline's five structured LLM calls, behind one injectable
 * interface so the end-to-end smoke test can drive the whole job (including
 * FFmpeg and ffprobe) with deterministic fake agents and no paid calls.
 *
 * The default implementation goes through the existing `runAgent` harness:
 * prompt load, `{{variable}}` render, json_object, schema validation, retries,
 * and telemetry — none of that is reimplemented here. Editorial guidelines are
 * intentionally OFF: the story prompts carry their own child-friendly rules.
 */

/**
 * Story prompts resolve at a fixed version, independent of PROMPT_VERSION.
 * The story pipeline ships its own prompts under `story-<agent>/`, and must
 * never be re-pointed at a missing higher version because the Shorts pipeline
 * pinned a different prompt version.
 */
const STORY_PROMPTS = promptPathsFor("v1");

export interface StoryAgentTelemetry {
  model?: string;
  totalTokens?: number;
  retries?: number;
  fromCache?: boolean;
}

export interface StoryAgentOutcome<T> {
  data: T | null;
  error?: string;
  telemetry: StoryAgentTelemetry;
}

export interface WriteStoryInput {
  topic: string;
  language: string;
  tone?: string;
  targetWords: number;
  feedback?: string;
  /** Measured in code; defaults to the lint thresholds for `targetWords`. */
  limits?: StoryStyleLimits;
}

export interface VerifyStoryInput {
  story: string;
  claims: StoryClaim[];
  language: string;
}

export interface PlanScenesInput {
  sentences: { id: string; text: string }[];
  wpm: number;
  sceneTargetMinSec: number;
  sceneTargetMaxSec: number;
}

export interface DesignCharactersInput {
  story: string;
  language: string;
}

export interface PlanSceneVisualsInput {
  sceneId: number;
  narration: string;
  visualPurpose: string;
  characters: {
    id: string;
    name: string;
    role: string;
    visualDescription: string;
  }[];
  language: string;
}

export interface StoryAgents {
  writeStory(input: WriteStoryInput): Promise<StoryAgentOutcome<StoryOutput>>;
  verifyStory(
    input: VerifyStoryInput,
  ): Promise<StoryAgentOutcome<StoryVerification>>;
  planScenes(input: PlanScenesInput): Promise<StoryAgentOutcome<SceneGrouping>>;
  designCharacters(
    input: DesignCharactersInput,
  ): Promise<StoryAgentOutcome<CharacterRegistry>>;
  planSceneVisuals(
    input: PlanSceneVisualsInput,
  ): Promise<StoryAgentOutcome<SceneVisualSlots>>;
}

function toTelemetry(result: {
  telemetry: {
    model?: string;
    totalTokens?: number;
    retries?: number;
    fromCache?: boolean;
  };
}): StoryAgentTelemetry {
  return {
    model: result.telemetry.model,
    totalTokens: result.telemetry.totalTokens,
    retries: result.telemetry.retries,
    fromCache: result.telemetry.fromCache,
  };
}

function renderSentences(sentences: { id: string; text: string }[]): string {
  return sentences
    .map((sentence) => `${sentence.id}: ${sentence.text}`)
    .join("\n");
}

function renderClaims(claims: StoryClaim[]): string {
  if (claims.length === 0) return "(none)";
  return claims
    .map(
      (claim) =>
        `- ${claim.claim} [${claim.status}]${claim.hedgeInNarration ? " (hedged in narration)" : ""}`,
    )
    .join("\n");
}

function renderCharacters(
  characters: {
    id: string;
    name: string;
    role: string;
    visualDescription: string;
  }[],
): string {
  if (characters.length === 0) return "(none)";
  return characters
    .map(
      (character) =>
        `- ${character.id}: ${character.name} — ${character.role}. Appearance: ${character.visualDescription}`,
    )
    .join("\n");
}

export interface CreateStoryAgentsOptions {
  inject?: AgentInject;
  configurable?: Record<string, unknown>;
}

export function createStoryAgents(
  options: CreateStoryAgentsOptions = {},
): StoryAgents {
  const shared = {
    inject: options.inject,
    configurable: options.configurable,
    useEditorialGuidelines: false,
  };

  return {
    async writeStory(input) {
      const limits = input.limits ?? storyStyleLimits(input.targetWords);
      const result = await runAgent({
        ...shared,
        agent: AgentModel.StoryAuthor,
        promptPath: STORY_PROMPTS.StoryAuthor,
        schema: StoryOutputSchema,
        generateOptions: {
          temperature: 0.8,
          responseFormat: { type: "json_object" },
        },
        variables: {
          topic: input.topic,
          language: input.language,
          tone: input.tone ?? "warm and curious",
          targetWords: String(input.targetWords),
          averageSentenceWords: String(limits.averageSentenceWords),
          maxSentenceWords: String(limits.maxSentenceWords),
          minWords: String(limits.minWords),
          maxWords: String(limits.maxWords),
          feedback: input.feedback ?? "(none)",
        },
      });
      return {
        data: result.data,
        error: result.error,
        telemetry: toTelemetry(result),
      };
    },

    async verifyStory(input) {
      const result = await runAgent({
        ...shared,
        agent: AgentModel.StoryVerifier,
        promptPath: STORY_PROMPTS.StoryVerifier,
        schema: StoryVerificationSchema,
        generateOptions: {
          temperature: 0.2,
          responseFormat: { type: "json_object" },
        },
        variables: {
          story: input.story,
          claims: renderClaims(input.claims),
          language: input.language,
        },
      });
      return {
        data: result.data,
        error: result.error,
        telemetry: toTelemetry(result),
      };
    },

    async planScenes(input) {
      const minWords = Math.max(
        1,
        Math.round((input.sceneTargetMinSec * input.wpm) / 60),
      );
      const maxWords = Math.max(
        minWords,
        Math.round((input.sceneTargetMaxSec * input.wpm) / 60),
      );
      const result = await runAgent({
        ...shared,
        agent: AgentModel.StoryScenePlanner,
        promptPath: STORY_PROMPTS.StoryScenePlanner,
        schema: SceneGroupingSchema,
        generateOptions: {
          temperature: 0.3,
          responseFormat: { type: "json_object" },
        },
        variables: {
          sentences: renderSentences(input.sentences),
          wpm: String(input.wpm),
          sceneTargetMinSec: String(input.sceneTargetMinSec),
          sceneTargetMaxSec: String(input.sceneTargetMaxSec),
          minWords: String(minWords),
          maxWords: String(maxWords),
        },
      });
      return {
        data: result.data,
        error: result.error,
        telemetry: toTelemetry(result),
      };
    },

    async designCharacters(input) {
      const result = await runAgent({
        ...shared,
        agent: AgentModel.StoryCharacterDesigner,
        promptPath: STORY_PROMPTS.StoryCharacterDesigner,
        schema: CharacterRegistrySchema,
        generateOptions: {
          temperature: 0.5,
          responseFormat: { type: "json_object" },
        },
        variables: {
          story: input.story,
          language: input.language,
        },
      });
      return {
        data: result.data,
        error: result.error,
        telemetry: toTelemetry(result),
      };
    },

    async planSceneVisuals(input) {
      const result = await runAgent({
        ...shared,
        agent: AgentModel.StoryVisualPlanner,
        promptPath: STORY_PROMPTS.StoryVisualPlanner,
        schema: SceneVisualSlotsSchema,
        generateOptions: {
          temperature: 0.6,
          responseFormat: { type: "json_object" },
        },
        variables: {
          sceneId: String(input.sceneId),
          narration: input.narration,
          visualPurpose: input.visualPurpose,
          characters: renderCharacters(input.characters),
          language: input.language,
        },
      });
      return {
        data: result.data,
        error: result.error,
        telemetry: toTelemetry(result),
      };
    },
  };
}
