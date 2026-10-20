import { execa } from "execa";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PipelineError } from "../utils/errors.js";

/**
 * Media probing and analysis helpers for the story pipeline.
 *
 * FFmpeg/ffprobe are invoked with argument ARRAYS (never shell strings) and
 * analysis output is parsed from stderr into structured records so a test can
 * assert on it without a real render.
 */

export interface StreamInfo {
  codec?: string;
  pixFmt?: string;
  width: number;
  height: number;
  fps: number;
  type: "video" | "audio" | "other";
}

function parseFps(raw: string | undefined): number {
  if (!raw) return 0;
  const match = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(raw.trim());
  if (!match) return 0;
  const num = Number(match[1]);
  const den = match[2] ? Number(match[2]) : 1;
  if (!den) return 0;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : 0;
}

export interface MediaInfo {
  streams: StreamInfo[];
  /** Container duration in seconds; 0 when ffprobe reports none. */
  durationSec: number;
}

/**
 * One ffprobe call for everything the story pipeline needs. The shared
 * composer `probe()` returns only width/height/duration/hasVideo/hasAudio/fps,
 * so the renderer used to call it *and* this function back to back on the same
 * file just to learn the duration twice.
 */
export async function probeMedia(input: string): Promise<MediaInfo> {
  const { stdout } = await execa(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      input,
    ],
    { timeout: 30_000 },
  ).catch((err: unknown) => {
    throw new PipelineError(
      `FFprobe failed for "${input}": ${(err as Error)?.message ?? String(err)}`,
      "STORY_MEDIA_ERROR",
    );
  });

  const data = JSON.parse(stdout) as {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
    }[];
    format?: { duration?: string };
  };

  const streams = (data.streams ?? []).map((stream) => ({
    codec: stream.codec_name,
    pixFmt: stream.pix_fmt,
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    fps: parseFps(stream.avg_frame_rate ?? stream.r_frame_rate),
    type:
      stream.codec_type === "video"
        ? ("video" as const)
        : stream.codec_type === "audio"
          ? ("audio" as const)
          : ("other" as const),
  }));

  const duration = Number(data.format?.duration ?? 0);
  return {
    streams,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
  };
}

export async function probeStreams(input: string): Promise<StreamInfo[]> {
  return (await probeMedia(input)).streams;
}

export interface GraySample {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Decode a still (or a frame of a video at `atSec`) to a small grayscale
 * pixel grid. An optional `preFilter` applies the same geometry as the render
 * (scale/crop) before downsampling, so a rendered frame and its source image
 * can be compared like-for-like.
 */
export async function readGraySample(
  input: string,
  options: {
    width?: number;
    height?: number;
    atSec?: number;
    preFilter?: string;
    workDir: string;
    tag: string;
  },
): Promise<GraySample> {
  const width = options.width ?? 32;
  const height = options.height ?? 18;
  const out = resolve(options.workDir, `${options.tag}.gray.raw`);
  const filters = [
    options.preFilter,
    `scale=${width}:${height}:flags=area`,
    "format=gray",
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(",");

  await execa(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      ...(options.atSec !== undefined ? ["-ss", options.atSec.toFixed(3)] : []),
      "-i",
      input,
      "-vf",
      filters,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      out,
    ],
    { timeout: 60_000 },
  ).catch((err: unknown) => {
    throw new PipelineError(
      `Failed to decode a grayscale sample from "${input}": ${(err as Error)?.message ?? String(err)}`,
      "STORY_MEDIA_ERROR",
    );
  });

  const pixels = new Uint8Array(await readFile(out));
  if (pixels.length < width * height) {
    throw new PipelineError(
      `Decoded sample from "${input}" is too small (${pixels.length} bytes for ${width}x${height})`,
      "STORY_MEDIA_ERROR",
    );
  }
  return { width, height, pixels: pixels.subarray(0, width * height) };
}

export function meanVariance(sample: GraySample): number {
  const { pixels } = sample;
  let sum = 0;
  for (const value of pixels) sum += value;
  const mean = sum / pixels.length;
  let variance = 0;
  for (const value of pixels) variance += (value - mean) ** 2;
  return variance / pixels.length;
}

/**
 * Pearson correlation between two equally-sized grayscale samples over a row
 * range. Used to confirm a rendered frame still shows the right scene image
 * while ignoring the burned-in subtitle band.
 */
export function correlation(
  a: GraySample,
  b: GraySample,
  rows: { from: number; to: number },
): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const from = Math.max(0, Math.floor(rows.from * a.height));
  const to = Math.min(a.height, Math.ceil(rows.to * a.height));

  let sumA = 0;
  let sumB = 0;
  let count = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < a.width; x++) {
      sumA += a.pixels[y * a.width + x];
      sumB += b.pixels[y * a.width + x];
      count++;
    }
  }
  if (count === 0) return 0;
  const meanA = sumA / count;
  const meanB = sumB / count;

  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < a.width; x++) {
      const da = a.pixels[y * a.width + x] - meanA;
      const db = b.pixels[y * a.width + x] - meanB;
      num += da * db;
      denA += da * da;
      denB += db * db;
    }
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

/** Fraction of sampled pixels in a row band that differ by more than `delta`. */
export function bandDifferenceRatio(
  a: GraySample,
  b: GraySample,
  rows: { from: number; to: number },
  delta = 24,
): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const from = Math.max(0, Math.floor(rows.from * a.height));
  const to = Math.min(a.height, Math.ceil(rows.to * a.height));
  let different = 0;
  let count = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < a.width; x++) {
      const index = y * a.width + x;
      if (Math.abs(a.pixels[index] - b.pixels[index]) > delta) different++;
      count++;
    }
  }
  return count === 0 ? 0 : different / count;
}

export interface BlackInterval {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceInterval {
  start?: number;
  end?: number;
  duration: number;
}

/** Parse `blackdetect` output from stderr. */
export function parseBlackIntervals(stderr: string): BlackInterval[] {
  const intervals: BlackInterval[] = [];
  const re =
    /black_start:(\d+(?:\.\d+)?)\s+black_end:(\d+(?:\.\d+)?)\s+black_duration:(\d+(?:\.\d+)?)/g;
  for (const match of stderr.matchAll(re)) {
    intervals.push({
      start: Number(match[1]),
      end: Number(match[2]),
      duration: Number(match[3]),
    });
  }
  return intervals;
}

/** Parse `silencedetect` output from stderr. */
export function parseSilenceIntervals(stderr: string): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  const starts: (number | undefined)[] = [];
  const startRe = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
  for (const match of stderr.matchAll(startRe)) {
    starts.push(Number(match[1]));
  }
  const endRe =
    /silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/g;
  let index = 0;
  for (const match of stderr.matchAll(endRe)) {
    intervals.push({
      start: starts[index],
      end: Number(match[1]),
      duration: Number(match[2]),
    });
    index++;
  }
  return intervals;
}

/**
 * FFmpeg filter for "the frame is empty", not "the frame is dark".
 *
 * Defaults are tuned for photographic footage: `pix_th=0.10` counts anything
 * under 10% luma as black, so a pre-dawn or stormy stickman illustration with
 * a large navy sky can trip it. This pipeline has no fades and no camera
 * motion, so a genuine defect (broken or missing source) is a frame with
 * essentially *no* pixels lit. Three settings make that distinction:
 *
 * - `d=0.1` reports any run of 100 ms (3 frames at 30 fps), so a short gap is
 *   visible in the log instead of being missed;
 * - `pix_th=0.05` only counts really black pixels (<5% luma), so gloomy but
 *   painted scenes are not "black";
 * - `picture_black_ratio_th=0.995` requires 99.5% of the frame to be black, so
 *   even a thin white stickman or a moon on black is excluded.
 */
export const BLACKDETECT_FILTER =
  "blackdetect=d=0.1:pix_th=0.05:picture_black_ratio_th=0.995";

export async function detectBlack(input: string): Promise<BlackInterval[]> {
  const { stderr } = await execa(
    "ffmpeg",
    [
      "-v",
      "info",
      "-i",
      input,
      "-vf",
      BLACKDETECT_FILTER,
      "-an",
      "-f",
      "null",
      "-",
    ],
    { timeout: 300_000 },
  );
  return parseBlackIntervals(stderr);
}

export async function detectSilence(
  input: string,
  thresholdDb = -50,
  minDurationSec = 1.0,
): Promise<SilenceInterval[]> {
  const { stderr } = await execa(
    "ffmpeg",
    [
      "-v",
      "info",
      "-i",
      input,
      "-af",
      `silencedetect=n=${thresholdDb}dB:d=${minDurationSec}`,
      "-f",
      "null",
      "-",
    ],
    { timeout: 300_000 },
  );
  return parseSilenceIntervals(stderr);
}

/** Content hash of a file's bytes — used for duplicate-image detection. */
export async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Parse `volumedetect` mean/max volume from stderr. */
export function parseVolume(stderr: string): {
  meanDb?: number;
  maxDb?: number;
} {
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  return {
    meanDb: mean ? Number(mean[1]) : undefined,
    maxDb: max ? Number(max[1]) : undefined,
  };
}

/** Mean loudness of an audio file in dBFS (undefined when unmeasurable). */
export async function measureLoudness(
  input: string,
): Promise<{ meanDb?: number; maxDb?: number }> {
  const { stderr } = await execa(
    "ffmpeg",
    ["-v", "info", "-i", input, "-af", "volumedetect", "-f", "null", "-"],
    { timeout: 120_000 },
  ).catch(() => ({ stderr: "" }));
  return parseVolume(stderr);
}
