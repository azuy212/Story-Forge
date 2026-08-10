import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TTSProvider, SynthesizeOptions, SynthesizeResult } from "./tts-provider.js";
import { config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";

const REQUEST_TIMEOUT_MS = 600_000;
const AUDIO_DIR = resolve("generated", "audio");

export class ChatterboxTTSProvider implements TTSProvider {
  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${config.ttsUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: opts.text }),
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

    const remoteFilename = typeof data.file === "string" && data.file.length > 0
      ? data.file
      : "narration.wav";
    const filename = opts.filename ?? remoteFilename;
    const dir = opts.runId ? resolve(AUDIO_DIR, opts.runId) : AUDIO_DIR;
    const filePath = resolve(dir, filename);

    const audioUrl = new URL(data.url, config.ttsUrl()).toString();

    const downloadController = new AbortController();
    const downloadTimeoutId = setTimeout(() => downloadController.abort(), REQUEST_TIMEOUT_MS);

    let audioResponse: Response;
    try {
      audioResponse = await fetch(audioUrl, { signal: downloadController.signal });
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

    const durationMs = getWavDurationMs(Buffer.from(audioBuffer));

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

  if (sampleRate === 0 || numChannels === 0 || bitsPerSample === 0 || dataSize === 0) {
    return Math.round(buffer.length / 160);
  }

  const bytesPerSecond = (sampleRate * numChannels * bitsPerSample) / 8;
  if (bytesPerSecond === 0) {
    return Math.round(buffer.length / 160);
  }

  return Math.round((dataSize / bytesPerSecond) * 1000);
}
