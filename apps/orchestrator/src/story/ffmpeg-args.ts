import {
  runFfmpeg,
  runFfmpegWithRetry,
} from "../providers/composer/ffmpeg/ffmpeg.js";
import { escapeSubtitlePath } from "../providers/composer/ffmpeg/subtitles.js";
import { staticScaleFilter } from "../providers/composer/ffmpeg/normalize.js";
import { DEFAULT_MAX_RETRIES } from "../utils/constants.js";

/**
 * FFmpeg argument construction for the story render.
 *
 * Everything here is a pure function of its inputs and returns an argument
 * ARRAY — no shell strings, so a path containing spaces, quotes, or commas
 * cannot be re-parsed by a shell (brief S8).
 */

export interface ConcatEntry {
  path: string;
  durationSec: number;
}

function quoteConcatPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a concat-demuxer list. Durations are frame-snapped by the caller, and
 * the LAST entry is repeated without a duration to work around the concat
 * demuxer's last-image bug (brief S8).
 */
export function buildConcatList(entries: ConcatEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`file ${quoteConcatPath(entry.path)}`);
    lines.push(`duration ${entry.durationSec.toFixed(6)}`);
  }
  lines.push(`file ${quoteConcatPath(entries[entries.length - 1].path)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Concatenate scene narration chunks, inserting `gapMs` of padding after each
 * and re-encoding once to a uniform mono 48 kHz PCM track. Chunk order is the
 * caller's responsibility (it is the scene order).
 */
export function buildNarrationConcatArgs(options: {
  chunkPaths: string[];
  gapMs: number;
  outputPath: string;
  sampleRate?: number;
}): string[] {
  const { chunkPaths, gapMs, outputPath } = options;
  const sampleRate = options.sampleRate ?? 48000;
  const gapSec = (gapMs / 1000).toFixed(3);

  const inputArgs = chunkPaths.flatMap((path) => ["-i", path]);
  // Pad BETWEEN chunks only. Padding after the last one used to append a
  // trailing gap, so the master (and the video) ran one gap past the last word.
  const padFilters = chunkPaths.map((_, index) => {
    const format = `[${index}:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono`;
    return index === chunkPaths.length - 1
      ? `${format}[a${index}]`
      : `${format},apad=pad_dur=${gapSec}[a${index}]`;
  });
  const concatInputs = chunkPaths.map((_, index) => `[a${index}]`).join("");
  const filter = `${padFilters.join(";")};${concatInputs}concat=n=${chunkPaths.length}:v=0:a=1[out]`;

  return [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    String(sampleRate),
    "-ac",
    "1",
    outputPath,
  ];
}

export interface StoryRenderArgsOptions {
  concatListPath: string;
  narrationPath: string;
  subtitlePath?: string;
  fontsDir?: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  audioBitrateKbps?: number;
}

/** The render's normalizing filter chain (Lanczos cover-crop to 1080p). */
export function buildRenderVideoFilter(options: {
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  subtitlePath?: string;
  fontsDir?: string;
}): string {
  const scaleChain = staticScaleFilter({
    width: options.width,
    height: options.height,
    fps: options.fps,
    kenBurnsEnabled: false,
    kenBurnsMaxZoom: 1,
    fit: "cover",
    scaleFlags: "lanczos",
    encoder: {
      name: "story",
      encoder: "libx264",
      crf: options.crf,
      preset: options.preset,
    },
  });

  if (!options.subtitlePath) return scaleChain;

  const parts = [`filename=${escapeSubtitlePath(options.subtitlePath)}`];
  if (options.fontsDir) {
    parts.push(`fontsdir=${escapeSubtitlePath(options.fontsDir)}`);
  }
  // The ASS file carries its own style, so no force_style is applied and the
  // burned-in subtitles match the sidecar exactly.
  return `${scaleChain},subtitles=${parts.join(":")}`;
}

/**
 * Build the SINGLE-PASS render command: concat-demuxer image stream plus the
 * narration track, normalized, subtitled, and encoded once (no intermediate
 * segment encodes and therefore no second lossy pass).
 */
export function buildRenderArgs(options: StoryRenderArgsOptions): string[] {
  const videoFilter = buildRenderVideoFilter({
    width: options.width,
    height: options.height,
    fps: options.fps,
    crf: options.crf,
    preset: options.preset,
    subtitlePath: options.subtitlePath,
    fontsDir: options.fontsDir,
  });

  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    options.concatListPath,
    "-i",
    options.narrationPath,
    "-vf",
    videoFilter,
    "-c:v",
    "libx264",
    "-crf",
    String(options.crf),
    "-preset",
    options.preset,
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(options.fps),
    "-c:a",
    "aac",
    "-b:a",
    `${options.audioBitrateKbps ?? 192}k`,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-shortest",
    "-movflags",
    "+faststart",
    options.outputPath,
  ];
}

/** Geometry-only filter used to compare a rendered frame with its source. */
export function buildCoverCropFilter(
  width: number,
  height: number,
  fps: number,
): string {
  return staticScaleFilter({
    width,
    height,
    fps,
    kenBurnsEnabled: false,
    kenBurnsMaxZoom: 1,
    fit: "cover",
    scaleFlags: "lanczos",
    encoder: { name: "story", encoder: "libx264", crf: 20, preset: "medium" },
  });
}

/** Run the narration concat with the shared retry wrapper. */
export async function concatNarrationWithGaps(options: {
  chunkPaths: string[];
  gapMs: number;
  outputPath: string;
  runLogSink?: import("../utils/run-log.js").RunLogSink | null;
  runId?: string;
}): Promise<void> {
  await runFfmpegWithRetry(
    buildNarrationConcatArgs(options),
    "concatenate scene narration with scene padding",
    DEFAULT_MAX_RETRIES,
    undefined,
    undefined,
    undefined,
    { runLogSink: options.runLogSink ?? null, runId: options.runId },
  );
}

/** Run the single-pass render. */
export async function renderStoryVideo(
  options: StoryRenderArgsOptions & {
    runLogSink?: import("../utils/run-log.js").RunLogSink | null;
    runId?: string;
    onProgress?: (progress: number) => void;
    totalDurationMs?: number;
  },
): Promise<void> {
  await runFfmpeg({
    args: buildRenderArgs(options),
    description: "render story video (single pass)",
    runLogSink: options.runLogSink ?? null,
    runId: options.runId,
    onProgress: options.onProgress,
    totalDurationMs: options.totalDurationMs,
    timeout: 1_800_000,
  });
}
