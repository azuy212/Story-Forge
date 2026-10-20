import { dirname, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import {
  bandDifferenceRatio,
  correlation,
  detectBlack,
  detectSilence,
  probeMedia,
  readGraySample,
} from "./media.js";
import type { GraySample } from "./media.js";
import {
  buildConcatList,
  buildCoverCropFilter,
  renderStoryVideo,
} from "./ffmpeg-args.js";
import { atomicWriteFile } from "./atomic.js";
import { packageRoot } from "./paths.js";
import type { JobPaths } from "./paths.js";
import type { AssStyleConfig, SubtitleCue } from "./subtitles.js";
import type {
  FfprobeSummary,
  RenderValidationCheck,
  RenderValidationReport,
  ResolvedStoryConfig,
  StoryScene,
  ValidationSeverity,
} from "./types.js";

/**
 * S8 render and validation.
 *
 * ONE encode pass: the still sequence goes in through the concat demuxer with
 * frame-snapped durations (last entry repeated) and the subtitles are burned in
 * the same FFmpeg run — there is no intermediate per-scene encode and therefore
 * no second lossy pass. The temp file is validated and only then atomically
 * renamed to final.mp4; a job is only `complete` after every check passes.
 */

/**
 * Cap on frame-vs-source checks: every scene up to this, evenly spaced above.
 */
export const SAMPLE_SCENE_COUNT = 6;
/** Sampling grid for the frame-vs-source comparison (192x108 = 16:9). */
const SAMPLE_WIDTH = 192;
const SAMPLE_HEIGHT = 108;
/** Rows above this fraction are compared; the rest is the subtitle band. */
const SUBTITLE_BAND_FROM = 0.82;

/**
 * The frame-vs-source check is comparative, not absolute.
 *
 * Two stickman scenes share a palette and line weight, so a correct frame can
 * correlate strongly with a neighbouring scene's source too. What proves the
 * right image is on screen is a *margin*: the frame must match its own source
 * better than any other scene by at least `FRAME_MATCH_MARGIN`. The absolute
 * floor is only a sanity check that the frame resembles an illustration at
 * all; it is deliberately low because the real correlation numbers are not yet
 * known for Gemini output.
 *
 * Both sides of the comparison mask the subtitle band (`SUBTITLE_BAND_FROM`),
 * so burned-in captions cannot tilt the result either way.
 */
const MIN_FRAME_CORRELATION = 0.35;
const FRAME_MATCH_MARGIN = 0.02;

const MIN_SUBTITLE_BAND_DIFFERENCE = 0.005;
/**
 * Any black interval above this is a defect. `detectBlack` only reports frames
 * that are 99.5% black below 5% luma, so a legitimate dark illustration cannot
 * reach it; below a third of a second the run is tolerated so one odd frame at
 * a cut never fails an otherwise good render.
 */
const MAX_BLACK_SECONDS = 0.35;
const MAX_SILENCE_SECONDS = 1.0;

/**
 * Only `gate` checks decide completion. A failed `warning` check is reported in
 * the manifest and the S8 report, but cannot throw away a good render.
 */
export function gateChecksPassed(checks: RenderValidationCheck[]): boolean {
  return checks.every((check) => check.severity === "warning" || check.passed);
}

export interface FrameMatchVerdict {
  passed: boolean;
  margin: number;
  detail: string;
}

/**
 * Decide whether a sampled frame shows its own source. Pure so the tuning
 * rule is testable without FFmpeg.
 */
export function frameMatchVerdict(
  own: number,
  bestOther: { sceneId: number; value: number },
): FrameMatchVerdict {
  const margin = own - bestOther.value;
  const passed = own >= MIN_FRAME_CORRELATION && margin >= FRAME_MATCH_MARGIN;
  return {
    passed,
    margin,
    detail:
      `correlation ${own.toFixed(3)} with its own source ` +
      `(floor ${MIN_FRAME_CORRELATION}); closest other scene ` +
      `${bestOther.sceneId || "none"} at ${bestOther.value.toFixed(3)} ` +
      `(margin ${margin.toFixed(3)}, needs >= ${FRAME_MATCH_MARGIN})`,
  };
}

export function storyAssFontsDir(): string | undefined {
  const configured = config.subtitleFontPath();
  const absolute = isAbsolute(configured)
    ? configured
    : resolve(packageRoot(), configured);
  return existsSync(absolute) ? dirname(absolute) : undefined;
}

export function storyAssStyle(config_: ResolvedStoryConfig): AssStyleConfig {
  return {
    fontName: config.subtitleFontName(),
    fontSize: config.subtitleFontSize(),
    primaryColor: config.subtitlePrimaryColor(),
    outlineColor: "&H00000000",
    outline: config.subtitleOutline(),
    marginV: config.subtitleMarginV(),
    playResX: config_.width,
    playResY: config_.height,
  };
}

export interface RenderStageOptions {
  scenes: StoryScene[];
  paths: JobPaths;
  config: ResolvedStoryConfig;
  cues: SubtitleCue[];
  frames: number[];
  audioDurationSec: number;
  runId: string;
  runLogSink?: import("../utils/run-log.js").RunLogSink | null;
  dryRun?: boolean;
}

export interface RenderStageResult {
  finalVideo: string;
  ffprobe: FfprobeSummary;
  validations: RenderValidationReport;
}

function sampleScenes(scenes: StoryScene[]): StoryScene[] {
  if (scenes.length <= SAMPLE_SCENE_COUNT) return scenes;
  // Evenly spaced, always including the first and last: a five-scene job is
  // now validated scene by scene instead of only first/middle/last.
  const indexes = Array.from({ length: SAMPLE_SCENE_COUNT }, (_, slot) =>
    Math.round((slot * (scenes.length - 1)) / (SAMPLE_SCENE_COUNT - 1)),
  );
  return [...new Set(indexes)].map((index) => scenes[index]);
}

function firstCueMidpoint(
  cues: SubtitleCue[],
  window: { start: number; end: number },
): number | undefined {
  const cue = cues.find(
    (entry) =>
      entry.startMs / 1000 >= window.start - 0.001 &&
      entry.startMs / 1000 < window.end,
  );
  if (!cue) return undefined;
  return (cue.startMs + cue.endMs) / 2000;
}

export async function validateRender(options: {
  videoPath: string;
  scenes: StoryScene[];
  cues: SubtitleCue[];
  config: ResolvedStoryConfig;
  audioDurationSec: number;
  workDir: string;
}): Promise<RenderValidationReport> {
  const checks: RenderValidationCheck[] = [];
  const push = (
    name: string,
    passed: boolean,
    detail: string,
    severity: ValidationSeverity = "gate",
  ): void => {
    checks.push({ name, passed, detail, severity });
  };

  const info = await probeMedia(options.videoPath);
  const streams = info.streams;
  const video = streams.find((stream) => stream.type === "video");
  const audio = streams.find((stream) => stream.type === "audio");
  const expectedFps = options.config.fps;

  push(
    "video_stream",
    Boolean(video),
    video
      ? `${video.codec} ${video.width}x${video.height} ${video.pixFmt}`
      : "missing",
  );
  push(
    "video_codec",
    video?.codec === "h264",
    `expected h264, got ${video?.codec ?? "none"}`,
  );
  push(
    "pixel_format",
    video?.pixFmt === "yuv420p",
    `expected yuv420p, got ${video?.pixFmt ?? "none"}`,
  );
  push(
    "resolution",
    video?.width === options.config.width &&
      video?.height === options.config.height,
    `expected ${options.config.width}x${options.config.height}, got ${video?.width ?? 0}x${video?.height ?? 0}`,
  );
  push(
    "frame_rate",
    Boolean(video) && Math.abs((video?.fps ?? 0) - expectedFps) <= 0.01,
    `expected ${expectedFps} fps, got ${video?.fps ?? 0}`,
  );
  push("audio_stream", Boolean(audio), audio ? `${audio.codec}` : "missing");
  push(
    "audio_codec",
    audio?.codec === "aac",
    `expected aac, got ${audio?.codec ?? "none"}`,
  );

  const durationSec = info.durationSec;
  const frameTolerance = 1 / expectedFps + 0.05;
  push(
    "duration_matches_audio",
    Math.abs(durationSec - options.audioDurationSec) <=
      Math.max(0.1, frameTolerance),
    `video ${durationSec.toFixed(3)}s vs audio ${options.audioDurationSec.toFixed(3)}s`,
  );

  const black = await detectBlack(options.videoPath);
  const longBlack = black.filter(
    (interval) => interval.duration > MAX_BLACK_SECONDS,
  );
  push(
    "no_black_frames",
    longBlack.length === 0,
    longBlack.length === 0
      ? `no interval longer than ${MAX_BLACK_SECONDS}s (${black.length} dark interval(s) seen)`
      : longBlack
          .map(
            (interval) =>
              `${interval.start.toFixed(2)}–${interval.end.toFixed(2)}s`,
          )
          .join(", "),
  );

  const silence = await detectSilence(
    options.videoPath,
    -50,
    MAX_SILENCE_SECONDS,
  );
  push(
    "no_long_silence",
    silence.length === 0,
    silence.length === 0
      ? `no silence longer than ${MAX_SILENCE_SECONDS}s at -50 dB`
      : silence
          .map(
            (interval) =>
              `${(interval.start ?? 0).toFixed(2)}s/${interval.duration.toFixed(2)}s`,
          )
          .join(", "),
  );

  const coverFilter = buildCoverCropFilter(
    options.config.width,
    options.config.height,
    options.config.fps,
  );

  // Read every scene's source once (192x108) so the frame check can prove the
  // *right* image is on screen, not merely that the frame resembles some image.
  const sourceSamples = new Map<number, GraySample>();
  const sourceSample = async (
    scene: StoryScene,
  ): Promise<GraySample | undefined> => {
    const imagePath = scene.image?.path;
    if (!imagePath) return undefined;
    const cached = sourceSamples.get(scene.sceneId);
    if (cached) return cached;
    const sample = await readGraySample(imagePath, {
      width: SAMPLE_WIDTH,
      height: SAMPLE_HEIGHT,
      preFilter: coverFilter,
      workDir: options.workDir,
      tag: `source-${scene.sceneId}`,
    });
    sourceSamples.set(scene.sceneId, sample);
    return sample;
  };

  for (const scene of sampleScenes(options.scenes)) {
    const timing = scene.timing;
    const imagePath = scene.image?.path;
    if (!timing || !imagePath) {
      push(
        `scene_${scene.sceneId}_frame`,
        false,
        "scene is missing timing or image",
      );
      continue;
    }
    const cueTime = firstCueMidpoint(options.cues, {
      start: timing.start,
      end: timing.end,
    });
    const atSec = cueTime ?? (timing.start + timing.end) / 2;

    try {
      const frame = await readGraySample(options.videoPath, {
        width: SAMPLE_WIDTH,
        height: SAMPLE_HEIGHT,
        atSec,
        workDir: options.workDir,
        tag: `frame-${scene.sceneId}`,
      });
      const source = await sourceSample(scene);
      if (!source) {
        push(`scene_${scene.sceneId}_frame`, false, "scene has no image");
        continue;
      }
      const band = { from: 0, to: SUBTITLE_BAND_FROM };
      const similar = correlation(frame, source, band);

      // The best-scoring *other* scene image. If another source matches this
      // frame at least as well, the wrong image is on screen — a flat fixture
      // that correlates with everything would slip past a one-sided check.
      let bestOther = { sceneId: 0, value: -2 };
      for (const other of options.scenes) {
        if (other.sceneId === scene.sceneId) continue;
        const otherSample = await sourceSample(other);
        if (!otherSample) continue;
        const value = correlation(frame, otherSample, band);
        if (value > bestOther.value) {
          bestOther = { sceneId: other.sceneId, value };
        }
      }
      const right = frameMatchVerdict(similar, bestOther);
      push(
        `scene_${scene.sceneId}_shows_source`,
        right.passed,
        right.detail,
        "warning",
      );
      if (cueTime !== undefined) {
        const bandDelta = bandDifferenceRatio(frame, source, {
          from: SUBTITLE_BAND_FROM,
          to: 1,
        });
        push(
          `scene_${scene.sceneId}_subtitles_visible`,
          bandDelta >= MIN_SUBTITLE_BAND_DIFFERENCE,
          `subtitle band difference ${(bandDelta * 100).toFixed(2)}% (>= ${(MIN_SUBTITLE_BAND_DIFFERENCE * 100).toFixed(2)}%)`,
        );
      }
    } catch (err) {
      push(
        `scene_${scene.sceneId}_frame`,
        false,
        `frame comparison failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  return { passed: gateChecksPassed(checks), checks };
}

export async function runRenderStage(
  options: RenderStageOptions,
): Promise<RenderStageResult> {
  const { scenes, paths, config: storyConfig, frames, cues } = options;

  const concatPath = resolve(paths.renderDir, "concat.txt");
  const entries = scenes.map((scene, index) => {
    if (!scene.image?.path) {
      throw new PipelineError(
        `Scene ${scene.sceneId} has no image to render`,
        "STORY_RENDER_INCOMPLETE",
      );
    }
    return {
      path: scene.image.path,
      // Frame-snapped duration: cumulative frame boundaries, never round(dur*fps).
      durationSec: frames[index] / storyConfig.fps,
    };
  });
  await atomicWriteFile(concatPath, buildConcatList(entries));

  const subtitlesPath = cues.length > 0 ? paths.subtitlesAss : undefined;
  const tempVideo = resolve(paths.renderDir, "final.tmp.mp4");

  if (options.dryRun) {
    return {
      finalVideo: paths.finalVideo,
      ffprobe: {
        width: storyConfig.width,
        height: storyConfig.height,
        fps: storyConfig.fps,
        duration: 0,
      },
      validations: { passed: true, checks: [] },
    };
  }

  try {
    await renderStoryVideo({
      concatListPath: concatPath,
      narrationPath: paths.narration,
      subtitlePath: subtitlesPath,
      fontsDir: storyAssFontsDir(),
      outputPath: tempVideo,
      width: storyConfig.width,
      height: storyConfig.height,
      fps: storyConfig.fps,
      crf: storyConfig.crf,
      preset: storyConfig.preset,
      runLogSink: options.runLogSink ?? null,
      runId: options.runId,
      totalDurationMs: options.audioDurationSec * 1000,
    });
  } catch (err) {
    // A failed FFmpeg run must not leave a half-written file that a later
    // stage (or a human) could mistake for the finished video. final.mp4 is
    // never touched before validation passes.
    await unlink(tempVideo).catch(() => undefined);
    throw err;
  }

  const validations = await validateRender({
    videoPath: tempVideo,
    scenes,
    cues,
    config: storyConfig,
    audioDurationSec: options.audioDurationSec,
    workDir: paths.renderDir,
  });

  if (!validations.passed) {
    const failures = validations.checks
      .filter((check) => check.severity === "gate" && !check.passed)
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; ");
    throw new PipelineError(
      `Rendered video failed validation: ${failures}`,
      "STORY_RENDER_INVALID",
    );
  }

  await rename(tempVideo, paths.finalVideo);

  const probed = await probeMedia(paths.finalVideo);
  const video = probed.streams.find((stream) => stream.type === "video");
  const audio = probed.streams.find((stream) => stream.type === "audio");
  const duration = { duration: probed.durationSec };

  return {
    finalVideo: paths.finalVideo,
    ffprobe: {
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      fps: video?.fps ?? 0,
      duration: Math.round(duration.duration * 1000) / 1000,
      videoCodec: video?.codec,
      audioCodec: audio?.codec,
      pixFmt: video?.pixFmt,
    },
    validations,
  };
}
