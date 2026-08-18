import { z } from "zod";

export const ImageGenerationFailureTypeEnum = z.enum([
  "content_policy",
  "invalid_prompt",
  "rate_limit",
  "timeout",
  "server_error",
  "authentication",
  "invalid_request",
  "unknown",
]);

export type ImageGenerationFailureType = z.infer<
  typeof ImageGenerationFailureTypeEnum
>;

export interface ImageGenerationError {
  provider: string;
  model: string;
  type: ImageGenerationFailureType;
  message: string;
  rawMessage?: string;
  retryable: boolean;
  originalPrompt: string;
  sceneId: number;
  timestamp: string;
}

export class ImageGenerationProviderError extends Error {
  constructor(public readonly info: ImageGenerationError) {
    super(info.message);
    this.name = "ImageGenerationProviderError";
  }
}

export function isImageGenerationProviderError(
  err: unknown,
): err is ImageGenerationProviderError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Error).name === "ImageGenerationProviderError" &&
    "info" in err
  );
}

/** Transient provider errors that may recover from retrying the SAME prompt. */
const RETRYABLE_TYPES: ReadonlySet<ImageGenerationFailureType> = new Set([
  "rate_limit",
  "timeout",
  "server_error",
]);

export function isRetryableFailure(type: ImageGenerationFailureType): boolean {
  return RETRYABLE_TYPES.has(type);
}

/**
 * Failures that should route to ImagePromptRepair instead of a blind retry:
 * the provider rejected the prompt itself. Everything else is either retried
 * (transient) or fatal — never blindly retried AND never prompt-repaired.
 */
const REPAIR_TYPES: ReadonlySet<ImageGenerationFailureType> = new Set([
  "content_policy",
  "invalid_prompt",
]);

export function isRepairCandidate(type: ImageGenerationFailureType): boolean {
  return REPAIR_TYPES.has(type);
}

/**
 * Fatal infrastructure problems that surface immediately, never repaired and
 * never blindly retried. `unknown` is fatal: an unclassifiable failure could
 * hide an authentication or infrastructure problem, so routing it to an LLM
 * prompt repair (or retrying the same prompt) would only waste money.
 */
const FATAL_TYPES: ReadonlySet<ImageGenerationFailureType> = new Set([
  "authentication",
  "invalid_request",
  "unknown",
]);

export function isFatalFailure(type: ImageGenerationFailureType): boolean {
  return FATAL_TYPES.has(type);
}

/**
 * Build a normalized error from a provider's structured error payload. The
 * provider boundary reports `{ type, message }`; this assembles the full
 * pipeline-facing record. No provider-specific parsing happens here or
 * downstream.
 */
export function normalizeImageGenerationError(input: {
  provider: string;
  model?: string;
  type: ImageGenerationFailureType;
  message: string;
  rawMessage?: string;
  originalPrompt: string;
  sceneId: number;
  timestamp?: string;
}): ImageGenerationError {
  const retryable = isRetryableFailure(input.type);
  return {
    provider: input.provider,
    model: input.model ?? "unknown",
    type: input.type,
    message: input.message,
    rawMessage: input.rawMessage,
    retryable,
    originalPrompt: input.originalPrompt,
    sceneId: input.sceneId,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}
