import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  TTSProvider,
  SynthesizeOptions,
  SynthesizeResult,
} from "./tts-provider.js";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { PipelineError } from "../utils/errors.js";
import { probe, runFfmpeg } from "./composer/ffmpeg/ffmpeg.js";
import {
  appendRunLogEvent,
  sanitizeHeaders,
  withProviderLog,
} from "../utils/run-log.js";

const OPENROUTER_TTS_BASE_URL = "https://openrouter.ai/api/v1/audio/speech";

const TTS_ERROR_CODE = "TTS_PROVIDER_ERROR";
const TTS_WRITE_ERROR_CODE = "TTS_WRITE_ERROR";

const MIN_ATEMPO = 0.85;
const MAX_ATEMPO = 1.15;

// The pipeline's generic TTS interface lets agents pass a curated voice name
// (the Chatterbox default is "narrator"). OpenRouter TTS models instead take a
// provider-specific voice id and reject generic names with HTTP 400, so a
// generic default must never be forwarded. Configured/supplied voices that
// aren't the generic default are still passed through; otherwise the model's
// own default voice is used (the OpenRouter docs treat voice as optional).
const DEFAULT_PIPELINE_VOICE = "narrator";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 8_000;
const MAX_RETRIES = 3;

// Transient failures worth backing off and retrying. Everything else
// (malformed request, auth, billing, unknown model) is permanent.
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 529]);

// Human-readable context for the status codes OpenRouter surfaces. Kept as
// fallback descriptions when the response body does not carry a message.
const STATUS_DESCRIPTIONS: Record<number, string> = {
  400: "malformed or unsupported request",
  401: "invalid or missing API key",
  402: "insufficient credits",
  403: "spend limit reached, key disabled, or access blocked",
  404: "unknown model or no provider",
  429: "rate limited",
  502: "upstream audio failure",
};

export class OpenRouterTTSProvider implements TTSProvider {
  cacheFingerprint(): string {
    return [
      "openrouter-tts-v1",
      config.openRouterTTSModel(),
      `voice=${config.openRouterTTSVoice() ?? "none"}`,
      `format=${config.openRouterTTSResponseFormat()}`,
      `targetWpm=${config.narrationTargetWpm() ?? "none"}`,
    ].join(":");
  }

  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    const sink = opts.runLogSink ?? null;
    const startedAt = Date.now();
    const model = config.openRouterTTSModel();
    const voice = resolveVoice(opts.voice);
    const responseFormat = config.openRouterTTSResponseFormat();

    const requestBody: Record<string, unknown> = {
      model,
      input: opts.text,
      response_format: responseFormat,
    };
    if (voice) {
      requestBody.voice = voice;
    }

    const synthEvent: Record<string, unknown> = {
      event: "provider_call",
      provider: "openrouter_tts",
      operation: "tts_synthesize",
      url: OPENROUTER_TTS_BASE_URL,
      method: "POST",
      headers: sanitizeHeaders({
        "Content-Type": "application/json",
        Authorization: "Bearer <redacted>",
      }),
      runId: opts.runId,
      model,
      voice: voice ?? undefined,
      responseFormat,
      textLength: opts.text.length,
      filename: opts.filename,
      requestBodyBytes: Buffer.byteLength(JSON.stringify(requestBody), "utf-8"),
    };

    const apiKey = config.openrouterApiKey();
    const timeoutMs = config.openRouterTTSTimeoutMs();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(
          RETRY_MAX_MS,
          RETRY_BASE_MS * 2 ** (attempt - 1),
        );
        const jitter = Math.random() * 250;
        logger.debug("OpenRouter TTS retry", {
          attempt,
          delayMs: Math.round(delay + jitter),
          error: lastError?.message,
        });
        await sleep(delay + jitter);
      }

      try {
        return await this.executeSynthesis({
          opts,
          sink,
          startedAt,
          model,
          voice,
          responseFormat,
          requestBody,
          apiKey,
          timeoutMs,
          synthEvent,
          attempt,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!isTransientTtsError(err)) {
          throw err;
        }
        if (attempt === MAX_RETRIES) {
          throw err;
        }
      }
    }

    throw lastError ?? new Error("OpenRouter TTS failed after retries");
  }

  private async executeSynthesis(params: {
    opts: SynthesizeOptions;
    sink: import("../utils/run-log.js").RunLogSink | null;
    startedAt: number;
    model: string;
    voice: string | undefined;
    responseFormat: string;
    requestBody: Record<string, unknown>;
    apiKey: string;
    timeoutMs: number;
    synthEvent: Record<string, unknown>;
    attempt: number;
  }): Promise<SynthesizeResult> {
    const {
      opts,
      sink,
      startedAt,
      model,
      voice,
      responseFormat,
      requestBody,
      apiKey,
      timeoutMs,
      synthEvent,
      attempt,
    } = params;
    const eventCopy: Record<string, unknown> = {
      ...synthEvent,
      attempt,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await withProviderLog(sink, eventCopy, async () => {
        const r = await fetch(OPENROUTER_TTS_BASE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        eventCopy.responseStatus = r.status;
        eventCopy.responseHeaders = sanitizeHeaders(
          Object.fromEntries(r.headers.entries()),
        );
        return r;
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error)?.name === "AbortError") {
        throw new PipelineError(
          `OpenRouter TTS request timed out after ${Math.round(timeoutMs / 1000)}s`,
          TTS_ERROR_CODE,
        );
      }
      throw new PipelineError(
        `OpenRouter TTS synthesis failed: ${(err as Error)?.message ?? String(err)}`,
        TTS_ERROR_CODE,
      );
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw await buildHttpError(response);
    }

    let audioBuffer: ArrayBuffer;
    try {
      audioBuffer = await response.arrayBuffer();
    } catch (err) {
      throw new PipelineError(
        `Failed to read OpenRouter TTS response: ${(err as Error)?.message ?? String(err)}`,
        TTS_ERROR_CODE,
      );
    }

    if (audioBuffer.byteLength === 0) {
      throw new PipelineError(
        "OpenRouter TTS returned empty audio response",
        TTS_ERROR_CODE,
      );
    }

    eventCopy.responseBodyBytes = audioBuffer.byteLength;

    const filename = opts.filename ?? `${randomUUID()}.${responseFormat}`;
    const dir = opts.runId
      ? resolve("generated", "audio", opts.runId)
      : resolve("generated", "audio");
    const finalPath = resolve(dir, filename);
    const tempPath = `${finalPath}.${randomUUID()}.tmp`;

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tempPath, Buffer.from(audioBuffer));
      await rename(tempPath, finalPath);
    } catch (err) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw new PipelineError(
        `Failed to save OpenRouter TTS audio: ${(err as Error)?.message ?? String(err)}`,
        TTS_WRITE_ERROR_CODE,
      );
    }

    let durationMs: number;
    try {
      const probeResult = await probe(finalPath);
      durationMs = Math.round(probeResult.duration * 1000);
    } catch {
      durationMs = Math.round((audioBuffer.byteLength / 16_000) * 1000);
    }

    const targetWpm =
      opts.videoProfile === "long" ? undefined : config.narrationTargetWpm();
    if (targetWpm && durationMs > 0) {
      const actualWpm = calculateWpm(opts.text, durationMs);
      if (actualWpm > 0) {
        const requestedSpeed = targetWpm / actualWpm;
        const speed = clampSpeed(requestedSpeed);

        if (Math.abs(speed - 1) > 0.001) {
          const tempWavPath = `${finalPath}.wpm.wav`;
          try {
            await runFfmpeg({
              args: [
                "-y",
                "-i",
                finalPath,
                "-filter:a",
                `atempo=${speed}`,
                "-c:a",
                "pcm_s16le",
                tempWavPath,
              ],
              description: "normalize OpenRouter TTS narration WPM",
              runLogSink: sink,
              runId: opts.runId,
            });

            // atempo scales duration by 1/speed without changing sample rate.
            durationMs = Math.round(durationMs / speed);
            await rename(tempWavPath, finalPath);
          } finally {
            await rm(tempWavPath, { force: true }).catch(() => {});
          }
        }
      }
    }

    appendRunLogEvent(sink, {
      event: "asset_written",
      kind: "tts_audio",
      path: finalPath,
      byteSize: audioBuffer.byteLength,
      provider: "openrouter_tts",
      runId: opts.runId,
      durationMs,
      model,
      voice,
      textLength: opts.text.length,
      totalDurationMs: Date.now() - startedAt,
    });

    return {
      audioUrl: finalPath,
      durationMs,
    };
  }
}

async function buildHttpError(response: Response): Promise<PipelineError> {
  let detail = STATUS_DESCRIPTIONS[response.status] ?? response.statusText;
  try {
    const errorBody = (await response.json()) as Record<string, unknown>;
    const inner = errorBody?.error as Record<string, unknown> | undefined;
    if (typeof inner?.message === "string" && inner.message.length > 0) {
      detail = inner.message;
    }
  } catch {
    // Error response body isn't JSON — fall back to the status description.
  }
  const error = new PipelineError(
    `OpenRouter TTS synthesis failed: HTTP ${response.status} ${detail}`,
    TTS_ERROR_CODE,
  );
  (error as PipelineError & { status?: number }).status = response.status;
  return error;
}

function resolveVoice(optsVoice: string | undefined): string | undefined {
  if (optsVoice && optsVoice !== DEFAULT_PIPELINE_VOICE) return optsVoice;
  return config.openRouterTTSVoice();
}

function isTransientTtsError(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    return RETRYABLE_STATUS_CODES.has(status);
  }
  // Local file errors are permanent (a retry won't fix the disk).
  if ((err as { code?: unknown }).code === TTS_WRITE_ERROR_CODE) {
    return false;
  }
  // Network failures and timeouts have no HTTP status: treat as transient.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countWords(text: string): number {
  return (text.match(/\b[\w'-]+\b/g) ?? []).length;
}

function calculateWpm(text: string, durationMs: number): number {
  const words = countWords(text);
  if (words === 0 || durationMs <= 0) return 0;
  return words / (durationMs / 60_000);
}

function clampSpeed(speed: number): number {
  return Math.min(MAX_ATEMPO, Math.max(MIN_ATEMPO, speed));
}
