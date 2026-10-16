import { randomUUID } from 'node:crypto';
import { isRetryableType, ProviderError } from '../core/errors.js';
import type { ProviderErrorType } from '../core/errors.js';

/** HTTP status for each normalized failure type. */
export const ERROR_STATUS: Record<ProviderErrorType, number> = {
  content_policy: 422,
  invalid_prompt: 422,
  rate_limit: 429,
  timeout: 504,
  server_error: 503,
  authentication: 401,
  invalid_request: 400,
  unknown: 500,
};

/** Provider identification attached to every error payload. */
export const PROVIDER_INFO = { provider: 'gemini', model: 'gemini-image-model' } as const;

export interface ProviderErrorPayload {
  error: {
    /** Stable machine-readable failure id (same value as `type`). */
    code: ProviderErrorType;
    type: ProviderErrorType;
    message: string;
    rawMessage?: string;
    provider: string;
    model: string;
    retryable: boolean;
    requestId?: string;
  };
}

/** Correlation id shared with the other provider services. */
export function newRequestId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * The provider's error envelope: `{ error: { type, message, provider, model,
 * retryable } }`. Kept in one module so the shape, the status mapping and the
 * provider identity cannot drift apart between the generate route and the
 * Fastify error handler.
 */
export function buildErrorPayload(
  err: ProviderError,
  providerInfo: { provider: string; model: string } = PROVIDER_INFO,
  requestId?: string,
): ProviderErrorPayload {
  return {
    error: {
      code: err.type,
      type: err.type,
      message: err.message,
      rawMessage: err.rawMessage ?? err.message,
      provider: providerInfo.provider,
      model: providerInfo.model,
      retryable: isRetryableType(err.type),
      requestId,
    },
  };
}

/** Malformed client input: the same envelope, with per-field details attached. */
export function buildValidationError(
  requestId: string | undefined,
  details: { field: string; message: string }[],
): { error: Record<string, unknown> } {
  return {
    error: {
      code: 'INVALID_REQUEST',
      message: 'Validation failed',
      requestId,
      details,
    },
  };
}

/** Status code for a provider error, with a safe fallback for unknown types. */
export function statusForProviderError(err: ProviderError): number {
  return ERROR_STATUS[err.type] ?? 503;
}
