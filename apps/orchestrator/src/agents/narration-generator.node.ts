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
import { OpenRouterTTSProvider } from "../providers/openrouter-tts-provider.js";
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
import { config as pipelineConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import {
  appendRunLogEvent,
  getRunLogSinkFromConfig,
} from "../utils/run-log.js";

const DEFAULT_PROVIDER = pipelineConfig.useRealProviders()
  ? pipelineConfig.ttsProviderType() === "openrouter"
    ? new OpenRouterTTSProvider()
    : new ChatterboxTTSProvider()
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

function validateScenes(scenes: Scene[]): { scenes: Scene[]; error?: string } {
  const ordered = [...scenes].sort((a, b) => a.sceneId - b.sceneId);
  const seen = new Set<number>();
  const duplicates = ordered.filter((scene) => {
    if (seen.has(scene.sceneId)) return true;
    seen.add(scene.sceneId);
    return false;
  });

  if (duplicates.length > 0) {
    return {
      scenes: ordered,
      error: `${AgentModel.NarrationGenerator}: Duplicate scene IDs (${duplicates.map((scene) => scene.sceneId).join(", ")})`,
    };
  }

  return { scenes: ordered };
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
  const startedAt = Date.now();
  const narrationMode = pipelineConfig.narrationGenerationMode();
  const label = nodeLabel(AgentModel.NarrationGenerator);
  logger.nodeStart(label);

  const initial = validateScenes(state.production?.scenes ?? []);
  if (initial.scenes.length === 0) {
    logger.nodeFailed(label, "No production scenes found");
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
  if (initial.error) {
    logger.nodeFailed(label, initial.error);
    return {
      audio: {},
      diagnostics: { errors: [initial.error] },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  // Complete mode synthesizes the entire narration (state.content.narration) in
  // a single TTS request so the output has continuous, cohesive prosody. Scene
  // durations are estimated proportionally (word-count share of total audio).
  if (narrationMode === "complete") {
    return runCompleteNarration(
      state,
      initial.scenes,
      config,
      label,
      startedAt,
    );
  }

  const input = validScenes(initial.scenes);
  if (input.error) {
    logger.nodeFailed(label, input.error);
    return {
      audio: {},
      diagnostics: { errors: [input.error] },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  logger.nodePhase(label, "generating voice audio");

  const scenes = input.scenes;
  const voice = state.branding?.voice ?? DEFAULT_VOICE;
  const provider = getTTSProvider(config);
  const runId = getArtifactNamespace(config, state);
  const runLogSink = getRunLogSinkFromConfig(config);

  const settledJobs = await Promise.allSettled(
    scenes.map(async (scene) => {
      const options: SynthesizeOptions = {
        text: scene.narration!.trim(),
        voice,
        filename: `scene-${padSceneId(scene.sceneId)}.wav`,
        runId,
        videoProfile: state.videoProfile?.profile,
        runLogSink,
      };
      const startedAt = Date.now();
      appendRunLogEvent(runLogSink, {
        event: "scene_event",
        node: AgentModel.NarrationGenerator,
        sceneId: scene.sceneId,
        kind: "start",
        narrationMode,
        runId,
        voice,
        textLength: options.text.length,
      });

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
        appendRunLogEvent(runLogSink, {
          event: "scene_event",
          node: AgentModel.NarrationGenerator,
          sceneId: scene.sceneId,
          kind: "end",
          outcome: "failed",
          errorReason: result.error,
          durationMs: Date.now() - startedAt,
          cacheHit: result.fromCache,
          narrationMode,
          runId,
        });
        return { scene, result };
      }

      const artifactId =
        result.ref?.artifactId ?? sceneAudioIdentity(scene, options, provider);
      appendRunLogEvent(runLogSink, {
        event: "scene_event",
        node: AgentModel.NarrationGenerator,
        sceneId: scene.sceneId,
        kind: "end",
        outcome: "resolved",
        durationMs: Date.now() - startedAt,
        cacheHit: result.fromCache,
        durationMsAudio: result.data.durationMs,
        url: result.data.url,
        narrationMode,
        runId,
      });
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
    logger.nodeFailed(label, `${failed.length}/${scenes.length} scenes failed`);
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
    filePath: scene.url!,
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

  logger.nodePhase(label, "normalizing audio");

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
    logger.nodeFailed(label, combined.error ?? "Combined narration is missing");
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

  logger.nodeDone(label, Date.now() - startedAt);

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

/**
 * Splits the actual total narration audio duration across scenes in
 * proportion to each scene's narration word count. This is an ESTIMATE used
 * to drive scene boundaries in complete mode: punctuation, pacing, and
 * emphasis mean identical word counts do not guarantee identical durations.
 * Scenes without narration text get an equal share.
 */
function estimateSceneDurationsMs(
  scenes: Scene[],
  totalDurationMs: number,
): number[] {
  const wordCounts = scenes.map(
    (scene) =>
      (scene.narration ?? "").trim().split(/\s+/).filter(Boolean).length,
  );
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);

  if (totalWords === 0) {
    return scenes.map(() =>
      Math.round(totalDurationMs / Math.max(1, scenes.length)),
    );
  }

  return wordCounts.map((count) =>
    Math.round((count / totalWords) * totalDurationMs),
  );
}

function completeNarrationCombinedKey(
  fullNarration: string,
  options: SynthesizeOptions,
  provider: TTSProvider,
  scenes: Scene[],
): Record<string, unknown> {
  return {
    kind: "combined",
    narrationMode: "complete",
    narration: fullNarration,
    ttsFingerprint: canonicalTTSFingerprint(options, provider),
    cacheVersion: AUDIO_CACHE_VERSION,
    scenes: scenes.map((scene) => ({
      sceneId: scene.sceneId,
      narration: (scene.narration ?? "").trim(),
    })),
  };
}

function completeNarrationSceneIdentity(
  scene: Scene,
  options: SynthesizeOptions,
  provider: TTSProvider,
): string {
  return `scene-${padSceneId(scene.sceneId)}-${hashObject({
    sceneId: scene.sceneId,
    narration: (scene.narration ?? "").trim(),
    tts: canonicalTTSFingerprint(options, provider),
    cacheVersion: AUDIO_CACHE_VERSION,
  }).slice(0, 16)}`;
}

async function runCompleteNarration(
  state: ProjectState,
  scenes: Scene[],
  config: RunnableConfig,
  label: string,
  startedAt: number,
): Promise<{
  audio: Partial<Audio>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const fullNarration = state.content?.narration?.trim();
  const voice = state.branding?.voice ?? DEFAULT_VOICE;
  const provider = getTTSProvider(config);
  const runId = getArtifactNamespace(config, state);
  const runLogSink = getRunLogSinkFromConfig(config);

  if (!fullNarration) {
    const error = `${AgentModel.NarrationGenerator}: complete narration mode requires content.narration`;
    logger.nodeFailed(label, error);
    return {
      audio: {},
      diagnostics: { errors: [error] },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  logger.nodePhase(label, "generating complete voice audio");

  appendRunLogEvent(runLogSink, {
    event: "scene_event",
    node: AgentModel.NarrationGenerator,
    sceneId: scenes.length,
    kind: "start",
    narrationMode: "complete",
    runId,
    voice,
    textLength: fullNarration.length,
  });

  const options: SynthesizeOptions = {
    text: fullNarration,
    voice,
    filename: "narration.wav",
    runId,
    videoProfile: state.videoProfile?.profile,
    runLogSink,
  };
  const combinedKey = completeNarrationCombinedKey(
    fullNarration,
    options,
    provider,
    scenes,
  );

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
        const ttsResult = await provider.synthesize(options);
        if (
          !Number.isFinite(ttsResult.durationMs) ||
          ttsResult.durationMs <= 0
        ) {
          return {
            data: null,
            error: "TTS returned invalid duration for complete narration",
          };
        }

        const estimatedDurationsMs = estimateSceneDurationsMs(
          scenes,
          ttsResult.durationMs,
        );
        const audioScenes: SceneAudio[] = scenes.map((scene, index) => ({
          sceneId: scene.sceneId,
          artifactId: completeNarrationSceneIdentity(scene, options, provider),
          narration: (scene.narration ?? "").trim(),
          durationMs: estimatedDurationsMs[index],
          // No per-scene audio URL: the single synthesized narration is the
          // combined artifact. WhisperX scene alignment therefore relies on
          // fallback to deterministic scene-bounded timing.
        }));

        return {
          data: {
            version: 2,
            scenes: audioScenes,
            combinedAudio: {
              artifactId: logicalAudioArtifactId("combined", combinedKey),
              durationMs: ttsResult.durationMs,
              url: ttsResult.audioUrl,
              sourceSceneArtifactIds: audioScenes.map(
                (scene) => scene.artifactId!,
              ),
            },
            narrationUrl: ttsResult.audioUrl,
            narrationDurationMs: ttsResult.durationMs,
            voice,
            generatedAt: new Date().toISOString(),
          },
        };
      } catch (err) {
        return {
          data: null,
          error: `${AgentModel.NarrationGenerator}: Complete narration TTS synthesis failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
    },
    withTopic(config, state),
  );

  if (combined.error || !combined.data) {
    appendRunLogEvent(runLogSink, {
      event: "scene_event",
      node: AgentModel.NarrationGenerator,
      sceneId: scenes.length,
      kind: "end",
      outcome: "failed",
      narrationMode: "complete",
      errorReason: combined.error,
      durationMs: Date.now() - startedAt,
      runId,
    });
    logger.nodeFailed(label, combined.error ?? "Complete narration is missing");
    return {
      audio: {},
      diagnostics: {
        errors: [
          combined.error ??
            `${AgentModel.NarrationGenerator}: Complete narration is missing`,
        ],
      },
      execution: { currentNode: AgentModel.NarrationGenerator },
    };
  }

  appendRunLogEvent(runLogSink, {
    event: "scene_event",
    node: AgentModel.NarrationGenerator,
    sceneId: scenes.length,
    kind: "end",
    outcome: "resolved",
    narrationMode: "complete",
    durationMs: Date.now() - startedAt,
    cacheHit: combined.fromCache,
    durationMsAudio: combined.data.narrationDurationMs,
    runId,
  });
  logger.nodeDone(label, Date.now() - startedAt);

  return {
    audio: combined.data,
    diagnostics: {},
    execution: { currentNode: AgentModel.NarrationGenerator },
  };
}
