import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import type { Audio } from "../schemas/audio.js";
import { AgentModel } from "../models/agent-model.js";
import type { TTSProvider } from "../providers/tts-provider.js";
import { StubTTSProvider } from "../providers/stub-tts-provider.js";
import { ChatterboxTTSProvider } from "../providers/chatterbox-tts-provider.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { getArtifactNamespace } from "../artifacts/context.js";
import { config } from "../utils/config.js";

const DEFAULT_PROVIDER = config.useRealProviders()
  ? new ChatterboxTTSProvider()
  : new StubTTSProvider();
const DEFAULT_VOICE = "en-US-Neural2-F";
const AUDIO_CACHE_VERSION = 2;

function getTTSProvider(config: RunnableConfig): TTSProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.ttsProvider as TTSProvider) ?? DEFAULT_PROVIDER;
}

export async function narrationGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  audio: Partial<Audio>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const narration = state.content?.narration;
  const voice = state.branding?.voice ?? DEFAULT_VOICE;

  if (!narration || narration.trim().length === 0) {
    return {
      audio: {},
      diagnostics: {
        errors: [
          `${AgentModel.NarrationGenerator}: Narration text is missing or empty`,
        ],
      },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  const provider = getTTSProvider(config);

  const result = await cacheNodeResult<Partial<Audio>>(
    {
      type: "audio",
      node: AgentModel.NarrationGenerator,
      // Provider identity: stub vs real TTS produce different audio for the
      // same text+voice; the cache must not mix them.
      key: {
        provider: provider.constructor.name,
        narration,
        voice,
        cacheVersion: AUDIO_CACHE_VERSION,
      },
    },
    async () => {
      try {
        const ttsResult = await provider.synthesize({
          text: narration,
          voice,
          runId: getArtifactNamespace(config, state),
        });
        return {
          data: {
            narrationUrl: ttsResult.audioUrl,
            narrationDurationMs: ttsResult.durationMs,
            voice,
            generatedAt: new Date().toISOString(),
          },
        };
      } catch (err) {
        return {
          data: null,
          error: `${AgentModel.NarrationGenerator}: TTS synthesis failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
    },
    config,
  );

  if (result.error) {
    return {
      audio: {},
      diagnostics: {
        errors: [result.error],
      },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  return {
    audio: result.data ?? {},
    diagnostics: {},
    execution: { currentNode: AgentModel.NarrationGenerator },
  };
}
