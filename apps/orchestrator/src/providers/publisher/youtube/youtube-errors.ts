/**
 * YouTube API error taxonomy. The provider converts every SDK failure into a
 * PublishErrorInfo so callers and the publication artifact can decide whether
 * retrying is worthwhile without knowing Google error internals.
 */

import { PublishError, type PublishErrorInfo } from "../publisher-provider.js";

export type { PublishErrorInfo };
export { PublishError };

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
]);

function isNetworkError(e: { code?: string | number }): boolean {
  return typeof e.code === "string" && NETWORK_CODES.has(e.code);
}

/**
 * Classify an unknown failure thrown by googleapis. Upload context defaults to
 * strict retryability; 4xx responses are permanent.
 */
export function mapYouTubeError(err: unknown): PublishErrorInfo {
  const e = (err ?? {}) as {
    code?: number | string;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };

  const message =
    e.errors?.[0]?.message ??
    e.message ??
    (err instanceof Error ? err.message : String(err));
  const reason = e.errors?.[0]?.reason;

  if (e.code === 429 || reason === "rateLimitExceeded") {
    return { code: "rate_limit", message, retryable: true };
  }
  if (typeof e.code === "number" && e.code >= 500 && e.code < 600) {
    return { code: "backend_error", message, retryable: true };
  }
  if (isNetworkError(e)) {
    return { code: "network_error", message, retryable: true };
  }
  if (e.code === 403) {
    if (reason === "quotaExceeded") {
      // Daily quota budget is spent; retrying today cannot succeed.
      return { code: "quota_exceeded", message, retryable: false };
    }
    return { code: "forbidden", message, retryable: false };
  }
  if (e.code === 401) {
    return { code: "auth_error", message, retryable: false };
  }
  if (e.code === 404) {
    return {
      code: "not_found",
      message,
      retryable: false,
    };
  }
  if (e.code === 400) {
    return { code: "invalid_request", message, retryable: false };
  }
  return { code: "unknown", message, retryable: false };
}

export function throwPublishError(info: PublishErrorInfo): never {
  throw new PublishError(info);
}
