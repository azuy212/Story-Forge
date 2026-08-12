import fs from "node:fs/promises";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
  SceneAudio,
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
import {
  resolveBranding,
  resolveBrandingAssetPath,
  type ResolvedBranding,
} from "../utils/branding.js";
import { config as appConfig } from "../utils/config.js";

const DEFAULT_PROVIDER = new FfmpegComposerProvider();

const FRAME_RATE = 30;
const MIN_SCALE_FACTOR = 0.5;
const MAX_SCALE_FACTOR = 2.0;

async function brandingAssetFingerprint(
  branding: ResolvedBranding,
): Promise<string> {
  if (!branding.enabled) return "disabled";

  try {
    const assetPath = resolveBrandingAssetPath(branding.outroAsset);
    const stat = await fs.stat(assetPath);
    return `${assetPath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${branding.outroAsset}:missing`;
  }
}

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

/** Align visual scene boundaries to natural duration of matching scene audio. */
export function alignSceneDurationsToAudio(
  scenes: Scene[],
  audioScenes: SceneAudio[],
): Scene[] {
  const audioById = new Map(audioScenes.map((audio) => [audio.sceneId, audio]));
  let accumulatedFrames = 0;

  return scenes.map((scene) => {
    const audio = audioById.get(scene.sceneId);
    if (!audio) {
      throw new Error(`Missing scene audio for scene ${scene.sceneId}`);
    }
    const frameCount = Math.max(
      1,
      Math.ceil((audio.durationMs / 1000) * FRAME_RATE),
    );
    const startFrames = accumulatedFrames;
    accumulatedFrames += frameCount;
    return {
      ...scene,
      startSecond: startFrames / FRAME_RATE,
      endSecond: accumulatedFrames / FRAME_RATE,
      durationSeconds: frameCount / FRAME_RATE,
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

  if (
    !state.audio?.combinedAudio ||
    !state.audio.scenes ||
    state.audio.scenes.length !== scenes.length
  ) {
    errors.push(
      `${AgentModel.VideoComposer}: complete scene audio manifest is missing`,
    );
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
  const narrationDurationMs = state.audio?.combinedAudio?.durationMs;
  const targetMs =
    narrationDurationMs && narrationDurationMs > 0
      ? narrationDurationMs
      : (state.content?.estimatedDurationSeconds ?? 0) * 1000;

  let timedScenes: Scene[];
  try {
    timedScenes = alignSceneDurationsToAudio(
      baseScenes,
      state.audio?.scenes ?? [],
    );
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

  const scenes: ComposeSceneInput[] = timedScenes.map((s) => ({
    sceneId: s.sceneId,
    assetUrl: s.assetUrl!,
    startSecond: s.startSecond ?? 0,
    endSecond: s.endSecond ?? 0,
    durationSeconds: s.durationSeconds ?? 0,
  }));
  const totalDurationSeconds = targetMs / 1000;
  const branding = resolveBranding(state.branding);
  const narrativeHoldSeconds = appConfig.narrativeHoldSeconds();
  const outroAssetFingerprint = await brandingAssetFingerprint(branding);

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
        narrativeHoldSeconds,
        narrationDurationMs: targetMs,
        branding: {
          ...branding,
          outroAssetFingerprint,
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
          narrativeHoldSeconds,
          branding: {
            channel: branding.channel,
            logo: state.branding?.logo,
            enabled: branding.enabled,
            outroAsset: branding.outroAsset,
            ctaEnabled: branding.ctaEnabled,
            outroCta: branding.outroCta,
            outroContainsCta: branding.outroContainsCta,
          },
          runId: getArtifactNamespace(config, state),
        });

        return {
          data: {
            videoUrl: composeResult.videoUrl,
            durationMs: composeResult.durationMs,
            resolution: composeResult.resolution,
            timeline: composeResult.timeline ?? {
              narrativeDurationMs: targetMs,
              narrativeHoldMs: narrativeHoldSeconds * 1000,
              outroDurationMs: 0,
              durationMs: composeResult.durationMs,
            },
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
      scenes: timedScenes,
    },
    video: result.data ?? {},
    diagnostics: {},
    execution: { currentNode: AgentModel.VideoComposer },
  };
}
