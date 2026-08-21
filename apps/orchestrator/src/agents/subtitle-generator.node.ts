import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import type { Subtitles } from "../schemas/subtitles.js";
import type { SceneAudio } from "../schemas/audio.js";
import { AgentModel } from "../models/agent-model.js";
import type { SceneSubtitleProvider } from "../providers/scene-subtitle-provider.js";
import { DeterministicSceneSubtitleProvider } from "../providers/scene-subtitle-provider.js";
import { WhisperXSceneSubtitleProvider } from "../providers/whisperx-scene-subtitle-provider.js";
import { HttpWhisperXProvider } from "../providers/whisperx-provider.js";
import type { GenerateSubtitlesResult } from "../providers/subtitle-provider.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { withTopic } from "../artifacts/context.js";
import { config as appConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";

const SUBTITLE_ALIGNMENT_VERSION = 5;

const DEFAULT_PROVIDER = new DeterministicSceneSubtitleProvider();
const REAL_PROVIDER = new WhisperXSceneSubtitleProvider(
  new HttpWhisperXProvider(),
);

/**
 * Tries the primary (WhisperX) provider and falls back to the deterministic
 * provider on any failure, logging a warning. The fallback decision lives at
 * the provider-selection boundary so a WhisperX outage degrades gracefully
 * instead of failing the subtitle node.
 */
export class FallbackSceneSubtitleProvider implements SceneSubtitleProvider {
  constructor(
    private readonly primary: SceneSubtitleProvider,
    private readonly fallback: SceneSubtitleProvider,
  ) {}

  async generateSceneSubtitles(
    scenes: Scene[],
    audioScenes: SceneAudio[],
  ): Promise<GenerateSubtitlesResult> {
    try {
      return await this.primary.generateSceneSubtitles(scenes, audioScenes);
    } catch (err) {
      logger.warn(
        "WhisperX subtitle alignment failed; using deterministic subtitles",
        { error: (err as Error)?.message ?? String(err) },
      );
      return this.fallback.generateSceneSubtitles(scenes, audioScenes);
    }
  }
}

const FALLBACK_REAL_PROVIDER = new FallbackSceneSubtitleProvider(
  REAL_PROVIDER,
  DEFAULT_PROVIDER,
);

function getSceneSubtitleProvider(
  config: RunnableConfig,
): SceneSubtitleProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  if (inject.sceneSubtitleProvider) {
    return inject.sceneSubtitleProvider as SceneSubtitleProvider;
  }
  // WhisperX provides real word-level alignment in real-provider mode; on
  // failure it falls back to deterministic scene-bounded timing.
  return appConfig.useRealProviders()
    ? FALLBACK_REAL_PROVIDER
    : DEFAULT_PROVIDER;
}

export async function subtitleGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  subtitles: Partial<Subtitles>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const startedAt = Date.now();
  const scenes = state.production?.scenes ?? [];
  const audioScenes = state.audio?.scenes ?? [];
  const combinedAudio = state.audio?.combinedAudio;
  const narration = state.content?.narration;
  const audioUrl = combinedAudio?.url ?? state.audio?.narrationUrl;
  const durationMs =
    combinedAudio?.durationMs ?? state.audio?.narrationDurationMs;

  const label = nodeLabel(AgentModel.SubtitleGenerator);
  logger.nodeStart(label);

  if (
    scenes.length === 0 ||
    audioScenes.length !== scenes.length ||
    !combinedAudio
  ) {
    logger.nodeFailed(
      nodeLabel(AgentModel.SubtitleGenerator),
      "Complete scene audio manifest is required",
    );
    return {
      subtitles: {},
      diagnostics: {
        errors: [
          `${AgentModel.SubtitleGenerator}: Complete scene audio manifest is required`,
        ],
      },
      execution: { currentNode: AgentModel.SubtitleGenerator },
    };
  }

  // Positional, not set, equality: scene audio order must match production
  // scene order. Scene audio is only meaningful when aligned to its scene.
  const productionIds = scenes.map((scene) => scene.sceneId);
  const audioIds = audioScenes.map((scene) => scene.sceneId);
  if (
    productionIds.length !== audioIds.length ||
    productionIds.some((id, index) => id !== audioIds[index])
  ) {
    logger.nodeFailed(
      nodeLabel(AgentModel.SubtitleGenerator),
      "Scene audio IDs do not match production scenes",
    );
    return {
      subtitles: {},
      diagnostics: {
        errors: [
          `${AgentModel.SubtitleGenerator}: Scene audio IDs do not match production scenes`,
        ],
      },
      execution: { currentNode: AgentModel.SubtitleGenerator },
    };
  }

  if (!audioUrl || !durationMs) {
    logger.nodeFailed(
      nodeLabel(AgentModel.SubtitleGenerator),
      "Audio URL or duration missing",
    );
    return {
      subtitles: {},
      diagnostics: {
        errors: [
          `${AgentModel.SubtitleGenerator}: Audio URL or duration missing`,
        ],
      },
      execution: { currentNode: AgentModel.SubtitleGenerator },
    };
  }

  const provider = getSceneSubtitleProvider(config);
  const providerName = provider.constructor.name;

  logger.nodePhase(label, "generating subtitles");

  const result = await cacheNodeResult<Partial<Subtitles>>(
    {
      type: "subtitles",
      node: AgentModel.SubtitleGenerator,
      // Scene audio identity and alignment version determine subtitle timing.
      key: {
        provider: providerName,
        narration,
        audioUrl,
        sceneAudio: audioScenes,
        subtitleAlignmentVersion: SUBTITLE_ALIGNMENT_VERSION,
      },
    },
    async () => {
      try {
        const providerResult = await provider.generateSceneSubtitles(
          scenes as Scene[],
          audioScenes as SceneAudio[],
        );
        return {
          data: {
            srt: providerResult.srt,
            ass: providerResult.ass,
            wordTimestamps: providerResult.wordTimestamps,
            generatedAt: new Date().toISOString(),
          },
        };
      } catch (err) {
        return {
          data: null,
          error: `${AgentModel.SubtitleGenerator}: Subtitle generation failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
    },
    withTopic(config, state),
  );

  if (result.error) {
    logger.nodeFailed(label, result.error);
    return {
      subtitles: {},
      diagnostics: {
        errors: [result.error],
      },
      execution: { currentNode: AgentModel.SubtitleGenerator },
    };
  }

  logger.nodeDone(label, Date.now() - startedAt);

  return {
    subtitles: result.data ?? {},
    diagnostics: {},
    execution: { currentNode: AgentModel.SubtitleGenerator },
  };
}
