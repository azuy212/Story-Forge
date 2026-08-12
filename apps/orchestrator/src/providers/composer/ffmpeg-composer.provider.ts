import path from "node:path";
import fs from "node:fs/promises";
import { cpus } from "node:os";
import { createTempDir, cleanupTempDir } from "./utils/temp.js";
import {
  probe,
  runFfmpegWithRetry,
  ENCODERS,
  type EncoderConfig,
} from "./ffmpeg/ffmpeg.js";
import {
  normalizeAsset,
  PAN_PRESET_COUNT,
  type NormalizeOptions,
} from "./ffmpeg/normalize.js";
import {
  concatWithTransitions,
  concatWithoutTransitions,
  type FadeTransition,
} from "./ffmpeg/concat.js";
import { escapeSubtitlePath, buildSubtitleStyle } from "./ffmpeg/subtitles.js";
import type { AudioDurationMode, AudioMixDuration } from "./ffmpeg/audio.js";
import type {
  ComposerProvider,
  ComposeOptions,
  ComposeResult,
} from "../composer-provider.js";
import { logger } from "../../utils/logger.js";
import { DEFAULT_MAX_RETRIES } from "../../utils/constants.js";
import { hashObject } from "../../artifacts/hash.js";
import { resolveBrandingAssetPath } from "../../utils/branding.js";

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
}

export interface KenBurnsConfig {
  enabled: boolean;
  maxZoom: number;
}

export interface EncoderPreset {
  name: string;
  encoder: string;
  crf: number;
  preset: string;
  extraArgs?: string[];
}

export interface FfmpegComposerConfig {
  video?: Partial<VideoConfig>;
  transitionDuration?: number;
  transitionType?: FadeTransition;
  subtitleFontSize?: number;
  subtitleFontName?: string;
  backgroundMusicPath?: string;
  bgmVolume?: number;
  kenBurns?: Partial<KenBurnsConfig>;
  audioDurationMode?: AudioDurationMode;
  audioMixDuration?: AudioMixDuration;
  normalizeConcurrency?: number;
  fastSeek?: boolean;
  encoder?: EncoderConfig | string;
  outputDir?: string;
  outroTransitionDuration?: number;
}

type ResolvedConfig = {
  video: VideoConfig;
  transitionDuration: number;
  transitionType: FadeTransition;
  subtitleFontSize: number;
  subtitleFontName: string;
  backgroundMusicPath: string;
  bgmVolume: number;
  kenBurns: KenBurnsConfig;
  audioDurationMode: AudioDurationMode;
  audioMixDuration: AudioMixDuration;
  normalizeConcurrency: number;
  fastSeek: boolean;
  encoder: EncoderConfig;
  outputDir: string;
  outroTransitionDuration: number;
};

const DEFAULT_ENCODER = ENCODERS.libx264;
const OUTRO_CTA_SAFE_AREA_Y = 0.86;

async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let nextIndex = 0;
  const limit = Math.max(1, concurrency);

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  // Wait for ALL workers (allSettled) before surfacing a failure: on a
  // rejected item, Promise.all would return early while other ffmpeg
  // processes are still running, and the temp dir cleanup in compose()'s
  // finally would delete files under live processes.
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return results;
}

function escapeDrawtextText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

export class FfmpegComposerProvider implements ComposerProvider {
  private readonly config: ResolvedConfig;

  constructor(config?: FfmpegComposerConfig) {
    let encoder: EncoderConfig;
    if (typeof config?.encoder === "string") {
      encoder = ENCODERS[config.encoder] ?? DEFAULT_ENCODER;
    } else if (config?.encoder) {
      encoder = { ...DEFAULT_ENCODER, ...config.encoder };
    } else {
      encoder = DEFAULT_ENCODER;
    }

    this.config = {
      video: {
        width: config?.video?.width ?? 1080,
        height: config?.video?.height ?? 1920,
        fps: config?.video?.fps ?? 30,
      },
      transitionDuration: config?.transitionDuration ?? 0,
      transitionType: config?.transitionType ?? "fade",
      subtitleFontSize: config?.subtitleFontSize ?? 24,
      subtitleFontName: config?.subtitleFontName ?? "Noto Sans",
      backgroundMusicPath: config?.backgroundMusicPath ?? "",
      bgmVolume: config?.bgmVolume ?? 0.15,
      kenBurns: {
        enabled: config?.kenBurns?.enabled ?? true,
        maxZoom: config?.kenBurns?.maxZoom ?? 1.15,
      },
      audioDurationMode: config?.audioDurationMode ?? "shortest",
      audioMixDuration: config?.audioMixDuration ?? "first",
      normalizeConcurrency:
        config?.normalizeConcurrency ??
        Math.max(2, Math.floor(cpus().length / 2)),
      fastSeek: config?.fastSeek ?? true,
      encoder,
      outputDir:
        config?.outputDir ?? path.join(process.cwd(), "output", "composed"),
      outroTransitionDuration: config?.outroTransitionDuration ?? 0.5,
    };
  }

  configFingerprint(): string {
    return hashObject(this.config);
  }

  async compose(
    opts: ComposeOptions,
    onProgress?: (stage: string, progress: number, detail?: string) => void,
    signal?: AbortSignal,
  ): Promise<ComposeResult> {
    const startTime = Date.now();

    await this.validateInputs(opts);

    const workDir = await createTempDir();
    const updateProgress = (
      stage: string,
      progress: number,
      detail?: string,
    ) => {
      logger.info(stage, { progress, detail, elapsed: Date.now() - startTime });
      onProgress?.(stage, progress, detail);
    };

    try {
      updateProgress("Preparing", 0);
      const srtPath = opts.srt
        ? await this.prepareSrt(opts.srt, workDir)
        : null;
      const branding = opts.branding?.enabled
        ? await this.prepareBranding(opts, workDir, signal)
        : null;

      updateProgress("Normalizing", 10, `${opts.scenes.length} scenes`);
      const sceneVideos = await this.normalizeAssets(
        opts,
        workDir,
        updateProgress,
        signal,
      );

      updateProgress("Concatenating", 30);
      const concatVideo = await this.buildConcatVideo(sceneVideos, signal);

      const narrativeVideo = await this.addNarrativeHold(
        concatVideo,
        opts.narrativeHoldSeconds ?? 0,
        workDir,
        signal,
      );

      const concatInfo = await probe(narrativeVideo);
      const totalDurationMs = concatInfo.duration * 1000;

      updateProgress("Audio", 45);
      const audioVideo = await this.addAudio(
        narrativeVideo,
        opts.narrationUrl,
        workDir,
        signal,
        totalDurationMs,
      );

      const finalBase = branding
        ? await this.appendOutro(audioVideo, branding.path, workDir, signal)
        : null;
      const finalBaseVideo = finalBase?.path ?? audioVideo;
      const finalBaseInfo = await probe(finalBaseVideo);
      const finalDurationMs = finalBaseInfo.duration * 1000;

      if (srtPath) {
        updateProgress("Subtitles", 60);
      }
      const subbedVideo = srtPath
        ? await this.burnSubtitlesStep(
          finalBaseVideo,
          srtPath,
          workDir,
          signal,
          finalDurationMs,
        )
        : finalBaseVideo;

      updateProgress("Exporting", 90);
      const exportDir = opts.runId
        ? path.join(this.config.outputDir, opts.runId)
        : this.config.outputDir;
      const finalVideo = await this.exportVideo(
        subbedVideo,
        signal,
        finalDurationMs,
        exportDir,
      );

      updateProgress("Completed", 100);
      const elapsed = Date.now() - startTime;
      logger.info("Completed successfully", { elapsed });

      const { durationMs, resolution } = await this.getOutputInfo(finalVideo);

      return {
        videoUrl: finalVideo,
        durationMs,
        resolution,
        timeline: {
          narrativeDurationMs: Math.round(
            (opts.totalDurationSeconds ?? 0) * 1000,
          ),
          narrativeHoldMs: Math.round((opts.narrativeHoldSeconds ?? 0) * 1000),
          outroDurationMs: branding?.durationMs ?? 0,
          outroTransitionMs: finalBase?.transitionDurationMs ?? 0,
          durationMs,
        },
      };
    } finally {
      try {
        await cleanupTempDir(workDir);
      } catch (e) {
        logger.warn("Failed to clean up temp directory", {
          dir: workDir,
          error: (e as Error)?.message ?? String(e),
        });
      }
    }
  }

  private async validateInputs(opts: ComposeOptions): Promise<void> {
    const errors: string[] = [];

    if (!opts.scenes || opts.scenes.length === 0) {
      errors.push("No scenes provided");
    } else {
      for (const scene of opts.scenes) {
        if (!scene.assetUrl) {
          errors.push(`Scene ${scene.sceneId} missing assetUrl`);
        }
        if (scene.durationSeconds <= 0) {
          errors.push(
            `Scene ${scene.sceneId} has invalid durationSeconds: ${scene.durationSeconds}`,
          );
        }
        if (scene.startSecond < 0) {
          errors.push(
            `Scene ${scene.sceneId} has negative startSecond: ${scene.startSecond}`,
          );
        }
      }
    }

    const fileChecks: Promise<void>[] = [];

    if (!opts.narrationUrl) {
      errors.push("Narration URL/path is missing");
    } else {
      fileChecks.push(
        this.requireFileExists(opts.narrationUrl, "Narration file"),
      );
      // Probe the audio file to ensure it actually contains audio
      fileChecks.push(
        (async () => {
          try {
            const probeResult = await probe(opts.narrationUrl);
            if (!probeResult.hasAudio) {
              errors.push(
                `Narration file contains no audio stream: ${opts.narrationUrl}`,
              );
            }
          } catch (err) {
            errors.push(
              `Failed to probe narration file: ${(err as Error)?.message ?? String(err)}`,
            );
          }
        })(),
      );
    }

    if (opts.branding?.enabled) {
      if (!opts.branding.outroAsset) {
        errors.push("Branding is enabled but branding.outroAsset is missing");
      } else {
        fileChecks.push(
          (async () => {
            try {
              const outroPath = resolveBrandingAssetPath(
                opts.branding!.outroAsset!,
              );
              const outroInfo = await probe(outroPath);
              if (!outroInfo.hasVideo || outroInfo.duration <= 0) {
                errors.push(`Branding outro has no usable video: ${outroPath}`);
              }
            } catch (err) {
              errors.push(
                `Branding outro validation failed: ${(err as Error)?.message ?? String(err)}`,
              );
            }
          })(),
        );
      }
    }

    if (this.config.backgroundMusicPath) {
      fileChecks.push(
        this.requireFileExists(
          this.config.backgroundMusicPath,
          "Background music",
        ),
      );
    }

    if (this.config.transitionDuration > 0 && opts.scenes.length > 1) {
      const minSceneDuration = Math.min(
        ...opts.scenes.map((s) => s.durationSeconds),
      );
      if (this.config.transitionDuration >= minSceneDuration) {
        errors.push(
          `transitionDuration (${this.config.transitionDuration}s) must be less than shortest scene duration (${minSceneDuration}s)`,
        );
      }
    }

    await Promise.all(fileChecks);

    if (errors.length > 0) {
      throw new Error(
        `FFmpegComposer validation failed:\n${errors.join("\n")}`,
      );
    }
  }

  private async requireFileExists(
    filePath: string,
    label: string,
  ): Promise<void> {
    try {
      await fs.access(filePath);
    } catch {
      throw new Error(`${label} not found: ${filePath}`);
    }
  }

  private async prepareSrt(
    srtContent: string,
    workDir: string,
  ): Promise<string> {
    const srtPath = path.join(workDir, "subtitles.srt");
    await fs.writeFile(srtPath, srtContent, "utf-8");
    return srtPath;
  }

  private async prepareBranding(
    opts: ComposeOptions,
    workDir: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; durationMs: number }> {
    const configuredAsset = opts.branding?.outroAsset;
    if (!configuredAsset) {
      throw new Error("Branding is enabled but branding.outroAsset is missing");
    }

    const sourcePath = resolveBrandingAssetPath(configuredAsset);
    const sourceInfo = await probe(sourcePath);
    const durationSeconds = sourceInfo.duration;
    const outputPath = path.join(workDir, "branding-outro.mp4");
    const videoFilter = [
      `scale=${this.config.video.width}:${this.config.video.height}:force_original_aspect_ratio=decrease`,
      `pad=${this.config.video.width}:${this.config.video.height}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1",
      `fps=${this.config.video.fps}`,
      "format=yuv420p",
      ...(opts.branding?.ctaEnabled &&
        !opts.branding.outroContainsCta &&
        opts.branding.outroCta
        ? [
          // CTA is deterministic, centered in lower safe area, and below
          // the supplied animation's existing "by Zain" lockup. Never add
          // channel name or handle here; outro animation owns branding.
          `drawtext=font='${this.config.subtitleFontName}':text='${escapeDrawtextText(opts.branding.outroCta)}':fontsize=${Math.max(18, this.config.subtitleFontSize)}:fontcolor=white:borderw=2:bordercolor=black@0.8:box=1:boxcolor=black@0.35:boxborderw=12:x=(w-text_w)/2:y=h*${OUTRO_CTA_SAFE_AREA_Y}`,
        ]
        : []),
    ].join(",");

    const args = [
      "-y",
      "-i",
      sourcePath,
      ...(sourceInfo.hasAudio
        ? []
        : [
          "-f",
          "lavfi",
          "-t",
          String(durationSeconds),
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
        ]),
      "-filter_complex",
      `[0:v]${videoFilter}[outv]`,
      "-map",
      "[outv]",
      "-map",
      sourceInfo.hasAudio ? "0:a:0" : "1:a:0",
      "-t",
      String(durationSeconds),
      "-c:v",
      this.config.encoder.encoder,
      "-crf",
      String(this.config.encoder.crf),
      "-preset",
      this.config.encoder.preset,
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-pix_fmt",
      "yuv420p",
    ];
    if (this.config.encoder.extraArgs)
      args.push(...this.config.encoder.extraArgs);
    args.push(outputPath);

    await runFfmpegWithRetry(
      args,
      "prepare canonical branding outro",
      DEFAULT_MAX_RETRIES,
      undefined,
      signal,
      durationSeconds * 1000,
    );

    const normalizedInfo = await probe(outputPath);
    return {
      path: outputPath,
      durationMs: Math.round(normalizedInfo.duration * 1000),
    };
  }

  private async addNarrativeHold(
    videoPath: string,
    holdSeconds: number,
    workDir: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (holdSeconds <= 0) return videoPath;
    const inputInfo = await probe(videoPath);
    const outputPath = path.join(workDir, "narrative-hold.mp4");
    const args = [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `tpad=stop_mode=clone:stop_duration=${holdSeconds}`,
      "-t",
      String(inputInfo.duration + holdSeconds),
      "-c:v",
      this.config.encoder.encoder,
      "-crf",
      String(this.config.encoder.crf),
      "-preset",
      this.config.encoder.preset,
      "-pix_fmt",
      "yuv420p",
      "-an",
    ];
    if (this.config.encoder.extraArgs)
      args.push(...this.config.encoder.extraArgs);
    args.push(outputPath);
    await runFfmpegWithRetry(
      args,
      "hold final narrative visual",
      DEFAULT_MAX_RETRIES,
      undefined,
      signal,
      inputInfo.duration * 1000,
    );
    return outputPath;
  }

  private async normalizeAssets(
    opts: ComposeOptions,
    workDir: string,
    onProgress: (stage: string, progress: number, detail?: string) => void,
    signal?: AbortSignal,
  ): Promise<{ filePath: string; durationSeconds: number }[]> {
    const items = opts.scenes.map((s) => ({
      sceneId: s.sceneId,
      assetUrl: s.assetUrl,
      durationSeconds: s.durationSeconds,
      startSecond: s.startSecond,
    }));

    const baseNormOpts: Omit<NormalizeOptions, "panVariant"> = {
      width: this.config.video.width,
      height: this.config.video.height,
      fps: this.config.video.fps,
      kenBurnsEnabled: this.config.kenBurns.enabled,
      kenBurnsMaxZoom: this.config.kenBurns.maxZoom,
      fastSeek: this.config.fastSeek,
      encoder: this.config.encoder,
    };

    return concurrentMap(
      items,
      async (scene, idx) => {
        const padded = String(idx).padStart(3, "0");
        const outputPath = path.join(workDir, `scene-${padded}.mp4`);

        onProgress(
          `Normalizing ${idx + 1}/${items.length}`,
          Math.round((idx / items.length) * 30),
          `Scene ${scene.sceneId}`,
        );

        await normalizeAsset(
          scene.assetUrl,
          outputPath,
          scene.durationSeconds,
          scene.startSecond,
          {
            ...baseNormOpts,
            panVariant: scene.sceneId % PAN_PRESET_COUNT,
          },
          signal,
        );

        return { filePath: outputPath, durationSeconds: scene.durationSeconds };
      },
      this.config.normalizeConcurrency,
    );
  }

  private async buildConcatVideo(
    sceneVideos: { filePath: string; durationSeconds: number }[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (sceneVideos.length === 0) {
      throw new Error("No scenes to concatenate");
    }
    const outputPath = path.join(
      path.dirname(sceneVideos[0].filePath),
      "concat.mp4",
    );
    const t = this.config.transitionDuration;

    if (t > 0 && sceneVideos.length > 1) {
      await concatWithTransitions(
        sceneVideos,
        outputPath,
        t,
        this.config.transitionType,
        this.config.encoder,
        signal,
      );
    } else {
      await concatWithoutTransitions(
        sceneVideos,
        outputPath,
        this.config.encoder,
        signal,
      );
    }

    return outputPath;
  }

  private async addAudio(
    videoPath: string,
    narrationUrl: string,
    workDir: string,
    signal?: AbortSignal,
    totalDurationMs?: number,
  ): Promise<string> {
    const outputPath = path.join(workDir, "with_audio.mp4");

    if (this.config.backgroundMusicPath) {
      const bgmVolume = this.config.bgmVolume;
      const mode = this.config.audioDurationMode;

      const amixFilter = `[narr][music]amix=inputs=2:duration=longest:dropout_transition=2${mode === "pad" ? ",apad" : ""}[outa]`;
      const args = [
        "-y",
        "-i",
        videoPath,
        "-i",
        narrationUrl,
        "-stream_loop",
        "-1",
        "-i",
        this.config.backgroundMusicPath,
        "-filter_complex",
        [
          `[1:a]volume=1.0[narr]`,
          `[2:a]volume=${bgmVolume}[music]`,
          amixFilter,
        ].join(";"),
        "-map",
        "0:v:0",
        "-map",
        "[outa]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        outputPath,
      ];

      await runFfmpegWithRetry(
        args,
        "mix narration with background music",
        DEFAULT_MAX_RETRIES,
        undefined,
        signal,
        totalDurationMs,
      );
    } else {
      const args = [
        "-y",
        "-i",
        videoPath,
        "-i",
        narrationUrl,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
      ];

      // Pad narration through the hold so -shortest ends with video, not voice.
      args.push("-af", "apad");
      args.push("-shortest", outputPath);

      await runFfmpegWithRetry(
        args,
        "add narration audio",
        DEFAULT_MAX_RETRIES,
        undefined,
        signal,
        totalDurationMs,
      );
    }

    return outputPath;
  }

  private async appendOutro(
    narrativeVideoPath: string,
    outroPath: string,
    workDir: string,
    signal?: AbortSignal,
  ): Promise<{
    path: string;
    transitionDurationMs: number;
  }> {
    const outputPath = path.join(workDir, "timeline-with-outro.mp4");
    const enc = this.config.encoder;

    const narrativeInfo = await probe(narrativeVideoPath);
    const outroInfo = await probe(outroPath);

    const transitionDuration = Math.min(
      this.config.outroTransitionDuration,
      narrativeInfo.duration,
      outroInfo.duration,
    );

    if (transitionDuration <= 0) {
      throw new Error(
        `Invalid outro transition duration: ${transitionDuration}s`,
      );
    }

    // xfade's offset is relative to the beginning of the first input.
    // Starting it transitionDuration before the end means the transition
    // happens during the final part of the narrative/hold.
    const offset = Math.max(
      0,
      narrativeInfo.duration - transitionDuration,
    );

    const args = [
      "-y",
      "-i",
      narrativeVideoPath,
      "-i",
      outroPath,

      "-filter_complex",
      [
        // Normalize video timestamps and formats for xfade.
        `[0:v]`
        + `settb=AVTB,`
        + `setpts=PTS-STARTPTS,`
        + `fps=${this.config.video.fps},`
        + `format=yuv420p`
        + `[v0]`,

        `[1:v]`
        + `settb=AVTB,`
        + `setpts=PTS-STARTPTS,`
        + `fps=${this.config.video.fps},`
        + `format=yuv420p`
        + `[v1]`,

        // Normalize audio before acrossfade.
        `[0:a]`
        + `aresample=48000,`
        + `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`
        + `asetpts=PTS-STARTPTS`
        + `[a0]`,

        `[1:a]`
        + `aresample=48000,`
        + `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`
        + `asetpts=PTS-STARTPTS`
        + `[a1]`,

        // Visual crossfade.
        `[v0][v1]`
        + `xfade=transition=fade:duration=${transitionDuration}:offset=${offset}`
        + `[outv]`,

        // Audio crossfade aligned with the visual transition.
        `[a0][a1]`
        + `acrossfade=d=${transitionDuration}:curve1=tri:curve2=tri`
        + `[outa]`,
      ].join(";"),

      "-map",
      "[outv]",
      "-map",
      "[outa]",

      "-c:v",
      enc.encoder,
      "-crf",
      String(enc.crf),
      "-preset",
      enc.preset,

      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",

      "-pix_fmt",
      "yuv420p",
    ];

    if (enc.extraArgs) {
      args.push(...enc.extraArgs);
    }

    args.push(outputPath);

    await runFfmpegWithRetry(
      args,
      "crossfade into canonical branding outro",
      DEFAULT_MAX_RETRIES,
      undefined,
      signal,
    );

    return {
      path: outputPath,
      transitionDurationMs: Math.round(transitionDuration * 1000),
    };
  }

  private async burnSubtitlesStep(
    videoPath: string,
    srtPath: string,
    workDir: string,
    signal?: AbortSignal,
    totalDurationMs?: number,
  ): Promise<string> {
    const outputPath = path.join(workDir, "subbed.mp4");
    const enc = this.config.encoder;
    const style = buildSubtitleStyle(
      this.config.subtitleFontSize,
      this.config.subtitleFontName,
    );
    const escapedPath = escapeSubtitlePath(srtPath);

    const args = [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `subtitles=filename=${escapedPath}:force_style='${style}'`,
      // Explicitly map video and audio to ensure audio isn't dropped
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:a",
      "copy",
      "-c:v",
      enc.encoder,
      "-crf",
      String(enc.crf),
      "-preset",
      enc.preset,
      "-pix_fmt",
      "yuv420p",
    ];

    if (enc.extraArgs) args.push(...enc.extraArgs);
    args.push(outputPath);

    await runFfmpegWithRetry(
      args,
      "burn subtitles",
      DEFAULT_MAX_RETRIES,
      undefined,
      signal,
      totalDurationMs,
    );
    return outputPath;
  }

  private async exportVideo(
    videoPath: string,
    signal?: AbortSignal,
    totalDurationMs?: number,
    outputDir?: string,
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = outputDir ?? this.config.outputDir;
    await fs.mkdir(dir, { recursive: true });

    const outputPath = path.join(dir, `final-${timestamp}.mp4`);

    // The video was already encoded (and re-encoded where filters require it)
    // in the subtitle/watermark steps. Re-encoding again here would add a full
    // unnecessary encode pass with generational loss; stream-copy + faststart
    // is enough to produce the final publishable file.
    const args: string[] = [
      "-y",
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ];

    await runFfmpegWithRetry(
      args,
      "final export",
      DEFAULT_MAX_RETRIES,
      undefined,
      signal,
      totalDurationMs,
    );
    return outputPath;
  }

  private async getOutputInfo(
    videoPath: string,
  ): Promise<{ durationMs: number; resolution: string }> {
    const info = await probe(videoPath);
    return {
      durationMs: Math.round(info.duration * 1000),
      resolution: `${info.width}x${info.height}`,
    };
  }
}
