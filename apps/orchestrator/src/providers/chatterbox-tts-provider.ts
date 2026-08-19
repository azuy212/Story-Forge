import { mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  TTSProvider,
  SynthesizeOptions,
  SynthesizeResult,
} from "./tts-provider.js";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { PipelineError } from "../utils/errors.js";
import { runFfmpeg } from "./composer/ffmpeg/ffmpeg.js";

const REQUEST_TIMEOUT_MS = 600_000;
const AUDIO_DIR = resolve("generated", "audio");

const MIN_ATEMPO = 0.85;
const MAX_ATEMPO = 1.15;

// Manual cache version. This is a DEPLOYMENT CONTRACT: whenever the
// server-side model/voice/audio pipeline changes in a way that alters audio
// for identical inputs, bump this constant at the same time as the deployment.
// Forgetting the bump risks serving stale cached audio for new outputs.
const CHATTERBOX_CACHE_VERSION = "v3";

export class ChatterboxTTSProvider implements TTSProvider {
  cacheFingerprint(): string {
    return [
      `chatterbox-http-${CHATTERBOX_CACHE_VERSION}`,
      config.ttsUrl(),
      `targetWpm=${config.narrationTargetWpm() ?? "none"}`,
    ].join(":");
  }

  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${config.ttsUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: opts.text,
          ...(opts.voice ? { voice: opts.voice } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error)?.name === "AbortError") {
        throw new PipelineError(
          "TTS request timed out after 10m",
          "TTS_PROVIDER_ERROR",
        );
      }
      throw new PipelineError(
        `TTS synthesis failed: ${(err as Error)?.message ?? String(err)}`,
        "TTS_PROVIDER_ERROR",
      );
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new PipelineError(
        `TTS synthesis failed: HTTP ${response.status} ${response.statusText}`,
        "TTS_PROVIDER_ERROR",
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PipelineError(
        "Invalid TTS response: invalid JSON",
        "TTS_PROVIDER_ERROR",
      );
    }

    if (typeof body !== "object" || body === null) {
      throw new PipelineError(
        "Invalid TTS response: expected JSON object",
        "TTS_PROVIDER_ERROR",
      );
    }

    const data = body as Record<string, unknown>;

    if (data.status !== "success") {
      throw new PipelineError(
        `TTS synthesis failed: status ${JSON.stringify(data.status)}`,
        "TTS_PROVIDER_ERROR",
      );
    }

    if (typeof data.url !== "string" || data.url.length === 0) {
      throw new PipelineError(
        "Invalid TTS response: missing or empty url",
        "TTS_PROVIDER_ERROR",
      );
    }

    const remoteFilename =
      typeof data.file === "string" && data.file.length > 0
        ? data.file
        : "narration.wav";
    const filename = opts.filename ?? remoteFilename;
    const dir = opts.runId ? resolve(AUDIO_DIR, opts.runId) : AUDIO_DIR;
    const filePath = resolve(dir, filename);

    const audioUrl = new URL(data.url, config.ttsUrl()).toString();

    const downloadController = new AbortController();
    const downloadTimeoutId = setTimeout(
      () => downloadController.abort(),
      REQUEST_TIMEOUT_MS,
    );

    let audioResponse: Response;
    try {
      audioResponse = await fetch(audioUrl, {
        signal: downloadController.signal,
      });
    } catch (err) {
      clearTimeout(downloadTimeoutId);
      if ((err as Error)?.name === "AbortError") {
        throw new PipelineError(
          "Audio download timed out after 10m",
          "TTS_PROVIDER_ERROR",
        );
      }
      throw new PipelineError(
        `Audio download failed: ${(err as Error)?.message ?? String(err)}`,
        "TTS_PROVIDER_ERROR",
      );
    }

    clearTimeout(downloadTimeoutId);

    if (!audioResponse.ok) {
      throw new PipelineError(
        `Audio download failed: HTTP ${audioResponse.status} ${audioResponse.statusText}`,
        "TTS_PROVIDER_ERROR",
      );
    }

    let audioBuffer: ArrayBuffer;
    try {
      audioBuffer = await audioResponse.arrayBuffer();
    } catch (err) {
      throw new PipelineError(
        `Failed to read audio response: ${(err as Error)?.message ?? String(err)}`,
        "TTS_PROVIDER_ERROR",
      );
    }

    if (audioBuffer.byteLength === 0) {
      throw new PipelineError(
        "Received empty audio response",
        "TTS_PROVIDER_ERROR",
      );
    }

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, Buffer.from(audioBuffer));
    } catch (err) {
      throw new PipelineError(
        `Failed to save audio: ${(err as Error)?.message ?? String(err)}`,
        "TTS_PROVIDER_ERROR",
      );
    }

    let durationMs = getWavDurationMs(Buffer.from(audioBuffer));

    const targetWpm = config.narrationTargetWpm();
    if (targetWpm) {
      const actualWpm = calculateWpm(opts.text, durationMs);

      if (actualWpm > 0) {
        const requestedSpeed = targetWpm / actualWpm;
        const speed = clampSpeed(requestedSpeed);

        logger.debug("TTS WPM normalization", {
          actualWpm: actualWpm.toFixed(1),
          targetWpm,
          speed: speed.toFixed(3),
        });

        if (Math.abs(speed - 1) > 0.001) {
          const tempPath = `${filePath}.speed.wav`;

          try {
            await runFfmpeg({
              args: [
                "-y",
                "-i",
                filePath,
                "-filter:a",
                `atempo=${speed}`,
                "-c:a",
                "pcm_s16le",
                tempPath,
              ],
              description: "normalize narration WPM",
            });

            const normalizedBuffer = await readFile(tempPath);

            await rename(tempPath, filePath);

            durationMs = getWavDurationMs(normalizedBuffer);

            const finalWpm = calculateWpm(opts.text, durationMs);

            logger.debug("TTS normalized duration", {
              durationMs,
              finalWpm: finalWpm.toFixed(1),
            });
          } finally {
            await rm(tempPath, { force: true }).catch(() => {});
          }
        }
      }
    }

    return {
      audioUrl: filePath,
      durationMs,
    };
  }
}

function getWavDurationMs(buffer: Buffer): number {
  if (buffer.length < 44) {
    return Math.round(buffer.length / 160);
  }

  const riffId = buffer.toString("ascii", 0, 4);
  const waveId = buffer.toString("ascii", 8, 12);
  if (riffId !== "RIFF" || waveId !== "WAVE") {
    return Math.round(buffer.length / 160);
  }

  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      audioFormat = buffer.readUInt16LE(offset + 8);
      sampleRate = buffer.readUInt32LE(offset + 12);
      numChannels = buffer.readUInt16LE(offset + 10);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) {
      offset++;
    }
  }

  if (audioFormat !== 1 && audioFormat !== 3) {
    return Math.round(buffer.length / 160);
  }

  if (
    sampleRate === 0 ||
    numChannels === 0 ||
    bitsPerSample === 0 ||
    dataSize === 0
  ) {
    return Math.round(buffer.length / 160);
  }

  const bytesPerSecond = (sampleRate * numChannels * bitsPerSample) / 8;
  if (bytesPerSecond === 0) {
    return Math.round(buffer.length / 160);
  }

  return Math.round((dataSize / bytesPerSecond) * 1000);
}

function countWords(text: string): number {
  return (text.match(/\b[\w'-]+\b/g) ?? []).length;
}

function calculateWpm(text: string, durationMs: number): number {
  const words = countWords(text);

  if (words === 0 || durationMs <= 0) {
    return 0;
  }

  return words / (durationMs / 60_000);
}

function clampSpeed(speed: number): number {
  return Math.min(MAX_ATEMPO, Math.max(MIN_ATEMPO, speed));
}
