import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import type { Video } from "../schemas/video.js";
import { AgentModel } from "../models/agent-model.js";
import type {
  ComposerProvider,
  ComposeSceneInput,
} from "../providers/composer-provider.js";
import { FfmpegComposerProvider } from "../providers/composer/ffmpeg-composer.provider.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { getArtifactNamespace } from "../artifacts/context.js";

const DEFAULT_PROVIDER = new FfmpegComposerProvider();

const FRAME_RATE = 30;
const MIN_SCALE_FACTOR = 0.5;
const MAX_SCALE_FACTOR = 2.0;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Scale planned scene durations so the storyboard's total matches the actual
 * narration duration. The planned storyboard is the pacing intent; the actual
 * WAV duration is the timing authority. Ceiling each scene to a whole number of
 * 30fps frames guarantees every scene duration and boundary lands on a frame
 * and the composed video is never shorter than the narration, so `-shortest`
 * trims video frames rather than cutting narration.
 *
 * The returned scenes satisfy the invariant:
 *   sum(durationSeconds) * 1000 >= targetMs
 */
export function scaleSceneDurations(
  scenes: Scene[],
  targetMs: number,
): Scene[] {
  if (targetMs <= 0) {
    throw new Error(`Cannot scale scenes: narration duration is ${targetMs}ms`);
  }

  const sumMs = scenes.reduce(
    (acc, s) => acc + (s.durationSeconds ?? 0) * 1000,
    0,
  );
  if (sumMs <= 0) {
    throw new Error(
      `Cannot scale scenes: planned scene durations sum to ${sumMs}ms`,
    );
  }

  const factor = targetMs / sumMs;
  if (factor < MIN_SCALE_FACTOR || factor > MAX_SCALE_FACTOR) {
    throw new Error(
      `Cannot scale scenes from ${sumMs}ms to ${targetMs}ms: factor=${round2(factor)}`,
    );
  }

  const scaledFrameCounts = scenes.map((s) =>
    Math.ceil((s.durationSeconds ?? 0) * factor * FRAME_RATE),
  );

  const targetFrames = Math.ceil((targetMs / 1000) * FRAME_RATE);
  const totalFrames = scaledFrameCounts.reduce(
    (acc, frames) => acc + frames,
    0,
  );
  if (totalFrames < targetFrames) {
    scaledFrameCounts[scaledFrameCounts.length - 1] +=
      targetFrames - totalFrames;
  }

  let accumulatedFrames = 0;
  return scenes.map((s, i) => {
    const startFrames = accumulatedFrames;
    accumulatedFrames += scaledFrameCounts[i];
    return {
      ...s,
      startSecond: startFrames / FRAME_RATE,
      endSecond: accumulatedFrames / FRAME_RATE,
      durationSeconds: scaledFrameCounts[i] / FRAME_RATE,
    };
  });
}

function getComposerProvider(config: RunnableConfig): ComposerProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.composerProvider as ComposerProvider) ?? DEFAULT_PROVIDER;
}

function collectErrors(state: ProjectState): string[] {
  const errors: string[] = [];

  const scenes = state.production?.scenes;
  if (!scenes || scenes.length === 0) {
    errors.push(`${AgentModel.VideoComposer}: No production scenes found`);
    return errors;
  }

  const scenesMissingUrl = scenes.filter((s) => !s.assetUrl);
  if (scenesMissingUrl.length > 0) {
    errors.push(
      `${AgentModel.VideoComposer}: ${scenesMissingUrl.length} scene(s) missing assetUrl (IDs: ${scenesMissingUrl.map((s) => s.sceneId).join(", ")})`,
    );
  }

  if (!state.audio?.narrationUrl) {
    errors.push(`${AgentModel.VideoComposer}: narrationUrl is missing`);
  }

  if (!state.subtitles?.srt) {
    errors.push(`${AgentModel.VideoComposer}: SRT subtitles are missing`);
  }

  return errors;
}

export async function videoComposerNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: { scenes?: Scene[]; plannedScenes?: Scene[] };
  video: Partial<Video>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const errors = collectErrors(state);
  if (errors.length > 0) {
    return {
      video: {},
      diagnostics: { errors },
      execution: { currentNode: AgentModel.VideoComposer },
    };
  }

  const baseScenes =
    state.production?.plannedScenes ?? state.production!.scenes!;
  const narrationDurationMs = state.audio?.narrationDurationMs;
  const targetMs =
    narrationDurationMs && narrationDurationMs > 0
      ? narrationDurationMs
      : (state.content?.estimatedDurationSeconds ?? 0) * 1000;

  let scaledScenes: Scene[];
  try {
    scaledScenes = scaleSceneDurations(baseScenes, targetMs);
  } catch (err) {
    return {
      production: {},
      video: {},
      diagnostics: {
        errors: [
          `${AgentModel.VideoComposer}: ${(err as Error)?.message ?? String(err)}`,
        ],
      },
      execution: { currentNode: AgentModel.VideoComposer },
    };
  }

  const scenes: ComposeSceneInput[] = scaledScenes.map((s) => ({
    sceneId: s.sceneId,
    assetUrl: s.assetUrl!,
    startSecond: s.startSecond ?? 0,
    endSecond: s.endSecond ?? 0,
    durationSeconds: s.durationSeconds ?? 0,
  }));
  const totalDurationSeconds = targetMs / 1000;

  const provider = getComposerProvider(config);

  const result = await cacheNodeResult<Partial<Video>>(
    {
      type: "videoPlan",
      node: AgentModel.VideoComposer,
      key: {
        // Provider identity + config version: swapping the composer or its
        // encoder/resolution settings must invalidate stale video artifacts.
        provider: provider.constructor.name,
        composerConfigVersion: provider.configFingerprint?.() ?? "1",
        scenes,
        narrationUrl: state.audio!.narrationUrl!,
        srt: state.subtitles!.srt!,
        totalDurationSeconds,
        narrationDurationMs: targetMs,
        branding: {
          channel: state.branding?.channel,
          logo: state.branding?.logo,
        },
      },
    },
    async () => {
      try {
        const composeResult = await provider.compose({
          scenes,
          narrationUrl: state.audio!.narrationUrl!,
          srt: state.subtitles!.srt!,
          totalDurationSeconds,
          branding: {
            channel: state.branding?.channel,
            logo: state.branding?.logo,
          },
          runId: getArtifactNamespace(config, state),
        });

        return {
          data: {
            videoUrl: composeResult.videoUrl,
            durationMs: composeResult.durationMs,
            resolution: composeResult.resolution,
            composedAt: new Date().toISOString(),
          },
        };
      } catch (err) {
        return {
          data: null,
          error: `${AgentModel.VideoComposer}: Video composition failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
    },
    config,
  );

  if (result.error) {
    return {
      video: {},
      diagnostics: {
        errors: [result.error],
      },
      execution: { currentNode: AgentModel.VideoComposer },
    };
  }

  return {
    production: {
      plannedScenes: baseScenes,
      scenes: scaledScenes,
    },
    video: result.data ?? {},
    diagnostics: {},
    execution: { currentNode: AgentModel.VideoComposer },
  };
}
