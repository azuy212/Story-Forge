import { execa } from "execa";
import { existsSync } from "node:fs";
import { DEFAULT_MAX_RETRIES } from "../../../utils/constants.js";
import { config } from "../../../utils/config.js";

type MediaBinary = "ffmpeg" | "ffprobe";

/**
 * Homebrew's ffmpeg-full formula is keg-only, so its binaries are not placed
 * on PATH. Prefer an explicit override, then a known ffmpeg-full location,
 * and finally the normal PATH lookup. This keeps Linux/CI behavior unchanged.
 */
export function resolveMediaBinary(binary: MediaBinary): string {
  const configured =
    binary === "ffmpeg" ? config.ffmpegPath() : config.ffprobePath();
  if (configured) return configured;

  const candidates = [
    `/opt/homebrew/opt/ffmpeg-full/bin/${binary}`,
    `/usr/local/opt/ffmpeg-full/bin/${binary}`,
    `/home/linuxbrew/.linuxbrew/opt/ffmpeg-full/bin/${binary}`,
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? binary;
}

export interface FfprobeResult {
  width: number;
  height: number;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  fps: number;
}

function parseFps(videoStream?: {
  r_frame_rate?: string;
  avg_frame_rate?: string;
}): number {
  const raw = videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate ?? "";
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(raw.trim());
  if (!m) return 0;
  const num = Number(m[1]);
  const den = m[2] ? Number(m[2]) : 1;
  if (!den) return 0;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : 0;
}

export async function probe(input: string): Promise<FfprobeResult> {
  let proc;
  try {
    proc = await execa(
      resolveMediaBinary("ffprobe"),
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
    );
  } catch (err) {
    throw new Error(
      `FFprobe failed for input "${input}": ${(err as Error)?.message ?? String(err)}`,
      { cause: err },
    );
  }

  const data = JSON.parse(proc.stdout);
  const videoStream = data.streams?.find(
    (s: { codec_type?: string }) => s.codec_type === "video",
  );
  const format = data.format ?? {};

  return {
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    duration: Number(format.duration ?? videoStream?.duration ?? 0),
    hasVideo: !!videoStream,
    hasAudio:
      data.streams?.some(
        (s: { codec_type?: string }) => s.codec_type === "audio",
      ) ?? false,
    fps: parseFps(videoStream),
  };
}

export interface EncoderConfig {
  name: string;
  encoder: string;
  crf: number | string;
  preset: string;
  extraArgs?: string[];
}

export const ENCODERS: Record<string, EncoderConfig> = {
  libx264: {
    name: "libx264",
    encoder: "libx264",
    crf: 20,
    preset: "medium",
  },
  libx264_fast: {
    name: "libx264_fast",
    encoder: "libx264",
    crf: 22,
    preset: "fast",
  },
  h264_nvenc: {
    name: "h264_nvenc",
    encoder: "h264_nvenc",
    crf: "20",
    preset: "p4",
    extraArgs: ["-rc", "vbr"],
  },
  h264_qsv: {
    name: "h264_qsv",
    encoder: "h264_qsv",
    crf: "20",
    preset: "medium",
    extraArgs: ["-global_quality", "20"],
  },
  h264_videotoolbox: {
    name: "h264_videotoolbox",
    encoder: "h264_videotoolbox",
    crf: "20",
    preset: "medium",
    extraArgs: ["-allow_sw", "1"],
  },
  h264_amf: {
    name: "h264_amf",
    encoder: "h264_amf",
    crf: "20",
    preset: "medium",
    extraArgs: ["-quality", "balanced"],
  },
};

export interface RunFfmpegOptions {
  args: string[];
  description: string;
  timeout?: number;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  totalDurationMs?: number;
}

export async function runFfmpeg(opts: RunFfmpegOptions): Promise<void> {
  const {
    args,
    description,
    timeout = 600_000,
    onProgress,
    signal,
    totalDurationMs,
  } = opts;

  const proc = execa(
    resolveMediaBinary("ffmpeg"),
    ["-progress", "pipe:1", "-nostats", ...args],
    { timeout },
  );

  let stderr = "";
  let stdout = "";

  const onAbort = () => {
    proc.kill("SIGTERM");
  };

  if (signal) {
    signal.addEventListener("abort", onAbort);
  }

  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  proc.stdout?.on("data", (data: Buffer) => {
    stdout += data.toString();
    if (onProgress) {
      parseProgress(stdout, onProgress, totalDurationMs);
    }
  });

  try {
    await proc;
  } catch (err) {
    if (signal?.aborted || (err as { isCanceled?: boolean })?.isCanceled) {
      throw new Error("FFmpeg operation cancelled", { cause: err });
    }
    const exitCode = proc.exitCode ?? "unknown";
    throw new Error(
      `FFmpeg ${description} failed (exit ${exitCode})\n` +
        `Command: ffmpeg ${args.join(" ")}\n` +
        `Stderr (last 2000 chars):\n${stderr.slice(-2000)}`,
      { cause: err },
    );
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function parseProgress(
  output: string,
  onProgress: (progress: number) => void,
  totalDurationMs?: number,
): void {
  const lines = output.trim().split("\n");
  let outTimeMs = 0;

  for (const line of lines) {
    const [key, value] = line.split("=");
    if (key === "out_time_us") {
      outTimeMs = Math.floor(parseInt(value, 10) / 1000);
    } else if (key === "out_time_ms" && outTimeMs === 0) {
      outTimeMs = parseInt(value, 10);
    } else if (key === "progress" && value === "end") {
      onProgress(100);
      return;
    }
  }

  if (totalDurationMs && totalDurationMs > 0 && outTimeMs > 0) {
    const progress = Math.min(100, (outTimeMs / totalDurationMs) * 100);
    onProgress(progress);
  }
}

export async function runFfmpegWithRetry(
  args: string[],
  description: string,
  maxRetries = DEFAULT_MAX_RETRIES,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  totalDurationMs?: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await runFfmpeg({
        args,
        description: `${description} (attempt ${attempt + 1}/${maxRetries + 1})`,
        onProgress,
        signal,
        totalDurationMs,
      });
      return;
    } catch (err) {
      lastError =
        (err as Error)?.message !== undefined
          ? (err as Error)
          : new Error(String(err));
      if (signal?.aborted) throw lastError;
      if (attempt < maxRetries) {
        const delay = Math.min(8000, 1000 * (attempt + 1));
        await new Promise<void>((resolve, reject) => {
          const timer: { handle?: ReturnType<typeof setTimeout> } = {};
          const onAbort = () => {
            if (timer.handle !== undefined) clearTimeout(timer.handle);
            signal?.removeEventListener("abort", onAbort);
            reject(new Error("FFmpeg operation cancelled"));
          };

          timer.handle = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, delay);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
    }
  }

  throw lastError;
}
