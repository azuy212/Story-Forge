import path from "node:path";
import { runFfmpegWithRetry } from "./ffmpeg.js";
import type { EncoderConfig } from "./ffmpeg.js";
import { DEFAULT_MAX_RETRIES } from "../../../utils/constants.js";
import type { RunLogSink } from "../../../utils/run-log.js";

export interface FfmpegCallContext {
  runLogSink?: RunLogSink | null;
  runId?: string;
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".avif",
]);

export interface NormalizeOptions {
  width: number;
  height: number;
  fps: number;
  kenBurnsEnabled: boolean;
  kenBurnsMaxZoom: number;
  /** Index into PAN_PRESETS; derived from sceneId so the same scene always pans the same way. */
  panVariant?: number;
  fastSeek?: boolean;
  encoder: EncoderConfig;
}

const PAN_PRESETS: { x: string; y: string }[] = [
  { x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" },
  { x: "(iw-iw/zoom)*{progress}", y: "ih/2-(ih/zoom/2)" },
  { x: "(iw-iw/zoom)*(1-{progress})", y: "ih/2-(ih/zoom/2)" },
  { x: "iw/2-(iw/zoom/2)", y: "(ih-ih/zoom)*{progress}" },
  { x: "iw/2-(iw/zoom/2)", y: "(ih-ih/zoom)*(1-{progress})" },
  { x: "(iw-iw/zoom)*{progress}", y: "(ih-ih/zoom)*{progress}" },
  { x: "(iw-iw/zoom)*(1-{progress})", y: "(ih-ih/zoom)*{progress}" },
];

export const PAN_PRESET_COUNT = PAN_PRESETS.length;

export function isImage(assetPath: string): boolean {
  const ext = path.extname(assetPath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export async function normalizeAsset(
  inputPath: string,
  outputPath: string,
  durationSeconds: number,
  startSecond: number,
  opts: NormalizeOptions,
  signal?: AbortSignal,
  context: FfmpegCallContext = {},
): Promise<void> {
  if (isImage(inputPath)) {
    await normalizeImage(
      inputPath,
      outputPath,
      durationSeconds,
      opts,
      signal,
      context,
    );
  } else {
    await normalizeVideo(
      inputPath,
      outputPath,
      durationSeconds,
      startSecond,
      opts,
      signal,
      context,
    );
  }
}

/**
 * Cover (fill): scale up so the short edge fills the canvas, then crop the
 * center. Unlike contain+pad there are no black bars, so the Ken Burns motion
 * zooms through picture rather than bars.
 */
function kenBurnsFilter(
  opts: NormalizeOptions,
  durationSeconds: number,
): string {
  const totalFrames = Math.max(2, Math.round(durationSeconds * opts.fps));
  const pan = PAN_PRESETS[(opts.panVariant ?? 0) % PAN_PRESET_COUNT];

  // Exact 0 -> 1 progress across the generated frames.
  const t = `(on-1)/(${totalFrames}-1)`;

  // Smoothstep interpolation gives the camera gentle acceleration/deceleration.
  const progress = `(3*pow(${t},2)-2*pow(${t},3))`;

  // Guard against caller-supplied maxZoom < 1, which would zoom *out* and
  // expose the source padding as black bars. Sub-1 zooms are unsupported.
  const maxZoom = Math.max(1, opts.kenBurnsMaxZoom);

  const zoomExpr = `1+(${maxZoom}-1)*${progress}`;

  const panX = pan.x.replaceAll("{progress}", progress);
  const panY = pan.y.replaceAll("{progress}", progress);

  const srcW = Math.ceil(opts.width * maxZoom);
  const srcH = Math.ceil(opts.height * maxZoom);
  return [
    `scale=${srcW}:${srcH}:force_original_aspect_ratio=increase`,
    "setsar=1",
    `zoompan=z='${zoomExpr}':x='${panX}':y='${panY}':d=${totalFrames}:s=${opts.width}x${opts.height}:fps=${opts.fps}`,
    "format=yuv420p",
  ].join(",");
}

async function normalizeImage(
  inputPath: string,
  outputPath: string,
  durationSeconds: number,
  opts: NormalizeOptions,
  signal?: AbortSignal,
  context: FfmpegCallContext = {},
): Promise<void> {
  const enc = opts.encoder;

  if (opts.kenBurnsEnabled) {
    const totalFrames = Math.max(2, Math.round(durationSeconds * opts.fps));

    const args = [
      "-y",
      "-loop",
      "1",
      "-i",
      inputPath,
      "-vf",
      kenBurnsFilter(opts, durationSeconds),
      "-frames:v",
      String(totalFrames),
      "-c:v",
      enc.encoder,
      "-crf",
      String(enc.crf),
      "-preset",
      enc.preset,
      "-pix_fmt",
      "yuv420p",
      "-an",
    ];

    if (enc.extraArgs) args.push(...enc.extraArgs);
    args.push(outputPath);

    await runFfmpegWithRetry(
      args,
      `normalize image scene with Ken Burns (${durationSeconds}s)`,
      DEFAULT_MAX_RETRIES,
      undefined,
      signal,
      undefined,
      context,
    );
  } else {
    const baseArgs = [
      "-y",
      "-loop",
      "1",
      "-i",
      inputPath,
      "-t",
      String(durationSeconds),
    ];

    const scaleFilter = staticScaleFilter(opts);
    const args = [
      ...baseArgs,
      "-vf",
      scaleFilter,
      "-c:v",
      enc.encoder,
      "-crf",
      String(enc.crf),
      "-preset",
      enc.preset,
      "-pix_fmt",
      "yuv420p",
      "-an",
    ];

    if (enc.extraArgs) args.push(...enc.extraArgs);
    args.push(outputPath);

    await runFfmpegWithRetry(
      args,
      `normalize image scene (${durationSeconds}s)`,
      DEFAULT_MAX_RETRIES,
      undefined,
      signal,
      undefined,
      context,
    );
  }
}

async function normalizeVideo(
  inputPath: string,
  outputPath: string,
  durationSeconds: number,
  startSecond: number,
  opts: NormalizeOptions,
  signal?: AbortSignal,
  context: FfmpegCallContext = {},
): Promise<void> {
  const enc = opts.encoder;
  const scaleFilter = staticScaleFilter(opts);
  const fastSeek = opts.fastSeek ?? true;

  const args: string[] = [
    "-y",
    ...(fastSeek ? ["-ss", String(startSecond)] : []),
    "-i",
    inputPath,
    ...(fastSeek ? [] : ["-ss", String(startSecond)]),
    "-t",
    String(durationSeconds),
    "-vf",
    scaleFilter,
    "-c:v",
    enc.encoder,
    "-crf",
    String(enc.crf),
    "-preset",
    enc.preset,
    "-pix_fmt",
    "yuv420p",
    "-an",
  ];

  if (enc.extraArgs) args.push(...enc.extraArgs);
  args.push(outputPath);

  await runFfmpegWithRetry(
    args,
    `normalize video scene (${durationSeconds}s)`,
    DEFAULT_MAX_RETRIES,
    undefined,
    signal,
    undefined,
    context,
  );
}

export function staticScaleFilter(opts: NormalizeOptions): string {
  return [
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease`,
    `pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    `fps=${opts.fps}`,
    "format=yuv420p",
  ].join(",");
}
