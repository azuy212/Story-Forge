import fs from "node:fs/promises";
import path from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import type { Audio, SceneAudio } from "../schemas/audio.js";
import { AgentModel } from "../models/agent-model.js";
import type {
  TTSProvider,
  SynthesizeOptions,
} from "../providers/tts-provider.js";
import { StubTTSProvider } from "../providers/stub-tts-provider.js";
import { ChatterboxTTSProvider } from "../providers/chatterbox-tts-provider.js";
import { canonicalTTSFingerprint } from "../providers/tts-fingerprint.js";
import {
  concatAudio,
  type AudioConcatInput,
  type AudioConcatResult,
} from "../providers/composer/ffmpeg/audio.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { getArtifactNamespace, withTopic } from "../artifacts/context.js";
import { hashObject } from "../artifacts/hash.js";
import { padSceneId } from "../utils/scene-id.js";
import { AUDIO_DURATION_TOLERANCE_MS } from "../utils/constants.js";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { nodeStart, nodeDone, nodeFailed } from "../utils/node-labels.js";

const DEFAULT_PROVIDER = config.useRealProviders()
  ? new ChatterboxTTSProvider()
  : new StubTTSProvider();
const DEFAULT_VOICE = "narrator";
const AUDIO_CACHE_VERSION = 3;
const CONCAT_VERSION = 1;

type AudioConcatenator = (
  inputs: AudioConcatInput[],
  outputPath: string,
) => Promise<AudioConcatResult>;

function getTTSProvider(config: RunnableConfig): TTSProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.ttsProvider as TTSProvider) ?? DEFAULT_PROVIDER;
}

function getAudioConcatenator(config: RunnableConfig): AudioConcatenator {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.audioConcatenator as AudioConcatenator) ?? concatAudio;
}

function logicalAudioArtifactId(kind: string, key: unknown): string {
  return `audio-${kind}-${hashObject(key).slice(0, 16)}`;
}

function sceneAudioIdentity(
  scene: Scene,
  options: SynthesizeOptions,
  provider: TTSProvider,
): string {
  return `scene-${padSceneId(scene.sceneId)}-${logicalAudioArtifactId("scene", {
    sceneId: scene.sceneId,
    tts: canonicalTTSFingerprint(options, provider),
    cacheVersion: AUDIO_CACHE_VERSION,
  }).slice("audio-scene-".length)}`;
}

function sceneAudioData(
  scene: Scene,
  options: SynthesizeOptions,
  result: { audioUrl: string; durationMs: number },
  artifactId?: string,
): SceneAudio {
  return {
    sceneId: scene.sceneId,
    ...(artifactId ? { artifactId } : {}),
    narration: options.text,
    durationMs: result.durationMs,
    url: result.audioUrl,
  };
}

function validScenes(scenes: Scene[]): { scenes: Scene[]; error?: string } {
  const ordered = [...scenes].sort((a, b) => a.sceneId - b.sceneId);
  const seen = new Set<number>();
  const invalid = ordered.filter((scene) => {
    if (seen.has(scene.sceneId)) return true;
    seen.add(scene.sceneId);
    return !scene.narration || scene.narration.trim().length === 0;
  });

  if (invalid.length > 0) {
    return {
      scenes: ordered,
      error: `${AgentModel.NarrationGenerator}: Invalid scene narration (IDs: ${invalid.map((scene) => scene.sceneId).join(", ")})`,
    };
  }

  return { scenes: ordered };
}

export async function narrationGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  audio: Partial<Audio>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const input = validScenes(state.production?.scenes ?? []);
  logger.info(nodeStart(AgentModel.NarrationGenerator), {
    scenes: input.scenes.length,
  });
  if (input.scenes.length === 0) {
    logger.warn(nodeFailed(AgentModel.NarrationGenerator), {
      error: "No production scenes found",
    });
    return {
      audio: {},
      diagnostics: {
        errors: [
          `${AgentModel.NarrationGenerator}: No production scenes found`,
        ],
      },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }
  if (input.error) {
    logger.warn(nodeFailed(AgentModel.NarrationGenerator), {
      error: input.error,
    });
    return {
      audio: {},
      diagnostics: { errors: [input.error] },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  const scenes = input.scenes;
  const voice = state.branding?.voice ?? DEFAULT_VOICE;
  const provider = getTTSProvider(config);
  const runId = getArtifactNamespace(config, state);

  const settledJobs = await Promise.allSettled(
    scenes.map(async (scene) => {
      const options: SynthesizeOptions = {
        text: scene.narration!.trim(),
        voice,
        filename: `scene-${padSceneId(scene.sceneId)}.wav`,
        runId,
      };

      const result = await cacheNodeResult<SceneAudio>(
        {
          type: "audio",
          node: AgentModel.NarrationGenerator,
          producerVersion: String(AUDIO_CACHE_VERSION),
          lookupAllVersions: true,
          key: {
            kind: "scene",
            sceneId: scene.sceneId,
            narration: options.text,
            ttsFingerprint: canonicalTTSFingerprint(options, provider),
            cacheVersion: AUDIO_CACHE_VERSION,
          },
        },
        async () => {
          try {
            const ttsResult = await provider.synthesize(options);
            if (
              !Number.isFinite(ttsResult.durationMs) ||
              ttsResult.durationMs <= 0
            ) {
              return {
                data: null,
                error: `TTS returned invalid duration for scene ${scene.sceneId}`,
              };
            }
            return {
              data: sceneAudioData(
                scene,
                options,
                ttsResult,
                sceneAudioIdentity(scene, options, provider),
              ),
            };
          } catch (err) {
            return {
              data: null,
              error: `${AgentModel.NarrationGenerator}: TTS synthesis failed for scene ${scene.sceneId}: ${(err as Error)?.message ?? String(err)}`,
            };
          }
        },
        withTopic(config, state),
      );

      if (!result.data) {
        return { scene, result };
      }

      const artifactId =
        result.ref?.artifactId ?? sceneAudioIdentity(scene, options, provider);
      return {
        scene,
        result: {
          ...result,
          data: { ...result.data, artifactId },
        },
      };
    }),
  );

  const jobs = settledJobs.map((settled, index) =>
    settled.status === "fulfilled"
      ? settled.value
      : {
          scene: scenes[index],
          result: {
            data: null,
            fromCache: false,
            error: `${AgentModel.NarrationGenerator}: TTS synthesis failed for scene ${scenes[index].sceneId}: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
          },
        },
  );

  const failed = jobs.filter((job) => job.result.error || !job.result.data);
  const successfulScenes = jobs
    .filter((job) => job.result.data)
    .map((job) => job.result.data!)
    .sort((a, b) => a.sceneId - b.sceneId);

  if (failed.length > 0) {
    logger.warn(nodeFailed(AgentModel.NarrationGenerator), {
      failedScenes: failed.length,
      totalScenes: scenes.length,
      error: failed[0]?.result.error,
    });
    return {
      audio: {
        version: 2,
        scenes: successfulScenes,
        voice,
        generatedAt: new Date().toISOString(),
      },
      diagnostics: {
        errors: failed.map(
          (job) =>
            job.result.error ??
            `${AgentModel.NarrationGenerator}: TTS failed for scene ${job.scene.sceneId}`,
        ),
      },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  const sceneInputs: AudioConcatInput[] = successfulScenes.map((scene) => ({
    sceneId: scene.sceneId,
    filePath: scene.url,
    durationMs: scene.durationMs,
  }));
  const sourceSceneArtifactIds = successfulScenes.map(
    (scene) => scene.artifactId!,
  );
  const combinedKey = {
    kind: "combined",
    concatVersion: CONCAT_VERSION,
    scenes: successfulScenes.map((scene) => ({
      sceneId: scene.sceneId,
      artifactId: scene.artifactId,
      durationMs: scene.durationMs,
    })),
  };
  const outputPath = path.resolve("generated", "audio", runId, "narration.wav");
  const concatenator = getAudioConcatenator(config);

  const combined = await cacheNodeResult<Audio>(
    {
      type: "audio",
      node: AgentModel.NarrationGenerator,
      producerVersion: String(AUDIO_CACHE_VERSION),
      lookupAllVersions: true,
      key: combinedKey,
    },
    async () => {
      try {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const result = await concatenator(sceneInputs, outputPath);
        const expectedDurationMs = successfulScenes.reduce(
          (sum, scene) => sum + scene.durationMs,
          0,
        );
        if (
          Math.abs(result.durationMs - expectedDurationMs) >
          AUDIO_DURATION_TOLERANCE_MS
        ) {
          throw new Error(
            `Combined duration ${result.durationMs}ms differs from scene sum ${expectedDurationMs}ms`,
          );
        }
        return {
          data: {
            version: 2,
            scenes: successfulScenes,
            combinedAudio: {
              artifactId: logicalAudioArtifactId("combined", combinedKey),
              durationMs: result.durationMs,
              url: result.audioPath,
              sourceSceneArtifactIds,
            },
            narrationUrl: result.audioPath,
            narrationDurationMs: result.durationMs,
            voice,
            generatedAt: new Date().toISOString(),
          },
        };
      } catch (err) {
        return {
          data: null,
          error: `${AgentModel.NarrationGenerator}: Audio concatenation failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
    },
    withTopic(config, state),
  );

  if (combined.error || !combined.data) {
    logger.warn(nodeFailed(AgentModel.NarrationGenerator), {
      error: combined.error ?? "Combined narration is missing",
    });
    return {
      audio: { version: 2, scenes: successfulScenes, voice },
      diagnostics: {
        errors: [
          combined.error ??
            `${AgentModel.NarrationGenerator}: Combined narration is missing`,
        ],
      },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  logger.info(nodeDone(AgentModel.NarrationGenerator), {
    scenes: successfulScenes.length,
    durationMs: combined.data.combinedAudio!.durationMs,
  });

  return {
    audio: {
      ...combined.data,
      combinedAudio: {
        ...combined.data.combinedAudio!,
        artifactId:
          combined.ref?.artifactId ??
          logicalAudioArtifactId("combined", combinedKey),
      },
      narrationUrl: combined.data.combinedAudio!.url,
      narrationDurationMs: combined.data.combinedAudio!.durationMs,
    },
    diagnostics: {},
    execution: { currentNode: AgentModel.NarrationGenerator },
  };
}
