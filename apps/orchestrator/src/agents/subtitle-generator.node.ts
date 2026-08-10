import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import type { Subtitles } from "../schemas/subtitles.js";
import { AgentModel } from "../models/agent-model.js";
import type { SubtitleProvider } from "../providers/subtitle-provider.js";
import { StubSubtitleProvider } from "../providers/stub-subtitle-provider.js";
import { WhisperXSubtitleProvider } from "../providers/whisperx-subtitle-provider.js";
import { HttpWhisperXProvider } from "../providers/whisperx-provider.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { config } from "../utils/config.js";

// Bump when subtitle alignment implementation changes (v1 was the
// 300ms/word heuristic; v2 is WhisperX word timestamps).
const SUBTITLE_ALIGNMENT_VERSION = 2;

const DEFAULT_PROVIDER = config.useRealProviders()
  ? new WhisperXSubtitleProvider(new HttpWhisperXProvider())
  : new StubSubtitleProvider();

function getSubtitleProvider(config: RunnableConfig): SubtitleProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.subtitleProvider as SubtitleProvider) ?? DEFAULT_PROVIDER;
}

export async function subtitleGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  subtitles: Partial<Subtitles>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const narration = state.content?.narration;
  const audioUrl = state.audio?.narrationUrl;
  const durationMs = state.audio?.narrationDurationMs;

  if (!narration || narration.trim().length === 0) {
    return {
      subtitles: {},
      diagnostics: {
        errors: [
          `${AgentModel.SubtitleGenerator}: Narration text is missing or empty`,
        ],
      },
      execution: { currentNode: AgentModel.SubtitleGenerator },
    };
  }

  if (!audioUrl || !durationMs) {
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

  const provider = getSubtitleProvider(config);

  const result = await cacheNodeResult<Partial<Subtitles>>(
    {
      type: "subtitles",
      node: AgentModel.SubtitleGenerator,
      // Subtitle timing must follow the actual narration WAV: provider
      // identity (stub vs WhisperX) plus the audio artifact URL determine the
      // resulting timestamps. The alignment version invalidates artifacts
      // produced by the old 300ms/word heuristic. A different WAV always
      // yields a different audioUrl, so it can never reuse old timestamps.
      key: {
        provider: provider.constructor.name,
        narration,
        audioUrl,
        subtitleAlignmentVersion: SUBTITLE_ALIGNMENT_VERSION,
      },
    },
    async () => {
      try {
        const providerResult = await provider.generateSubtitles(
          audioUrl,
          narration,
          durationMs,
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
    config,
  );

  if (result.error) {
    return {
      subtitles: {},
      diagnostics: {
        errors: [result.error],
      },
      execution: { currentNode: AgentModel.SubtitleGenerator },
    };
  }

  return {
    subtitles: result.data ?? {},
    diagnostics: {},
    execution: { currentNode: AgentModel.SubtitleGenerator },
  };
}
