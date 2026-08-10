import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { WordTimestamp } from "./subtitle-provider.js";
import { config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";

export interface AlignResult {
  wordTimestamps: WordTimestamp[];
}

export interface WhisperXProvider {
  align(audioUrl: string, narration?: string): Promise<AlignResult>;
}

const REQUEST_TIMEOUT_MS = 600_000;
const ALIGN_PATH = "/align";
const BOUNDARY = `----pipeline-whisperx-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

interface WhisperXWord {
  word?: unknown;
  start?: unknown;
  end?: unknown;
}

interface WhisperXSegment {
  words?: unknown;
}

interface WhisperXResponse {
  segments?: unknown;
}

/**
 * Sends the actual generated narration WAV to the WhisperX alignment service
 * and normalizes its word-level output into the pipeline's internal
 * WordTimestamp[] representation. HTTP details stay here.
 *
 * Contract: POST {TRANSCRIBER_URL}/align with multipart/form-data
 *   audio (audio/wav) — the actual narration WAV (required)
 *   text (string)     — known transcript hint (optional)
 * Response 200 JSON:
 *   { segments: [{ start, end, text, words: [{ word, start, end, score }] }] }
 */
export class HttpWhisperXProvider implements WhisperXProvider {
  constructor(private readonly serviceUrl: string = config.transcriberUrl()) {}

  async align(audioUrl: string, narration?: string): Promise<AlignResult> {
    let audioBuffer: Buffer;
    try {
      audioBuffer = await readFile(audioUrl);
    } catch (err) {
      throw new PipelineError(
        `WhisperX alignment failed: could not read audio file ${audioUrl}: ${(err as Error)?.message ?? String(err)}`,
        "WHISPERX_PROVIDER_ERROR",
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const multipartBody = buildMultipartBody(
      audioBuffer,
      basename(audioUrl),
      narration,
    );

    let response: Response;
    try {
      response = await fetch(`${this.serviceUrl}${ALIGN_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
        },
        body: multipartBody as unknown as BodyInit,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error)?.name === "AbortError") {
        throw new PipelineError(
          `WhisperX alignment timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
          "WHISPERX_PROVIDER_ERROR",
        );
      }
      throw new PipelineError(
        `WhisperX alignment failed: ${(err as Error)?.message ?? String(err)}`,
        "WHISPERX_PROVIDER_ERROR",
      );
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new PipelineError(
        `WhisperX alignment failed: HTTP ${response.status} ${response.statusText}`,
        "WHISPERX_PROVIDER_ERROR",
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PipelineError(
        "WhisperX alignment failed: invalid JSON in response",
        "WHISPERX_PROVIDER_ERROR",
      );
    }

    const wordTimestamps = normalizeWhisperXResponse(body);
    if (wordTimestamps.length === 0) {
      throw new PipelineError(
        "WhisperX alignment failed: response contained no word timestamps",
        "WHISPERX_PROVIDER_ERROR",
      );
    }

    return { wordTimestamps };
  }
}

function buildMultipartBody(
  audio: Buffer,
  filename: string,
  narration?: string,
): Buffer {
  const parts: Buffer[] = [];
  const push = (s: string) => parts.push(Buffer.from(s, "utf-8"));

  push(`--${BOUNDARY}\r\n`);
  push(
    `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n`,
  );
  push("Content-Type: audio/wav\r\n\r\n");
  parts.push(audio);
  push("\r\n");

  if (narration && narration.trim().length > 0) {
    push(`--${BOUNDARY}\r\n`);
    push(`Content-Disposition: form-data; name="text"\r\n\r\n`);
    push(narration);
    push("\r\n");
  }

  push(`--${BOUNDARY}--\r\n`);
  return Buffer.concat(parts);
}

function normalizeWhisperXResponse(body: unknown): WordTimestamp[] {
  if (typeof body !== "object" || body === null) {
    throw new PipelineError(
      "WhisperX alignment failed: expected JSON object response",
      "WHISPERX_PROVIDER_ERROR",
    );
  }

  const segments = (body as WhisperXResponse).segments;
  if (!Array.isArray(segments)) {
    throw new PipelineError(
      "WhisperX alignment failed: response missing segments array",
      "WHISPERX_PROVIDER_ERROR",
    );
  }

  const timestamps: WordTimestamp[] = [];
  for (const segment of segments as WhisperXSegment[]) {
    if (typeof segment !== "object" || segment === null) continue;
    if (!Array.isArray(segment.words)) continue;

    for (const raw of segment.words as WhisperXWord[]) {
      if (typeof raw !== "object" || raw === null) continue;

      const word = raw.word;
      if (typeof word !== "string" || word.trim().length === 0) continue;

      const start = raw.start;
      const end = raw.end;
      if (
        typeof start !== "number" ||
        !Number.isFinite(start) ||
        typeof end !== "number" ||
        !Number.isFinite(end)
      ) {
        throw new PipelineError(
          `WhisperX alignment failed: word "${word}" missing valid start/end timestamps`,
          "WHISPERX_PROVIDER_ERROR",
        );
      }

      timestamps.push({ word, start, end });
    }
  }

  return timestamps;
}
