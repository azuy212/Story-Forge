import { isRetryableType, ProviderError } from '../core/errors';
import type { ProviderErrorType } from '../core/errors';

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
    type: ProviderErrorType;
    message: string;
    rawMessage?: string;
    provider: string;
    model: string;
    retryable: boolean;
  };
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
): ProviderErrorPayload {
  return {
    error: {
      type: err.type,
      message: err.message,
      rawMessage: err.rawMessage ?? err.message,
      provider: providerInfo.provider,
      model: providerInfo.model,
      retryable: isRetryableType(err.type),
    },
  };
}

/** Status code for a provider error, with a safe fallback for unknown types. */
export function statusForProviderError(err: ProviderError): number {
  return ERROR_STATUS[err.type] ?? 503;
}
