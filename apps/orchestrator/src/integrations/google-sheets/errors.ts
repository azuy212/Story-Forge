import { getErrorMessage } from "../../utils/errors.js";

export interface SheetsErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export class SheetsError extends Error {
  readonly info: SheetsErrorInfo;

  constructor(info: SheetsErrorInfo) {
    super(info.message);
    this.name = "SheetsError";
    this.info = info;
  }
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Classify a raw failure from the Sheets API into a stable, retryable-aware
 * error, mirroring `mapYouTubeError` in the YouTube provider.
 */
export function classifySheetsError(error: unknown): SheetsErrorInfo {
  const raw = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = raw.code;
  const status = raw.status;
  const message = getErrorMessage(error);

  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return { code: "network_error", message, retryable: true };
  }

  if (status === 429 || code === 429 || code === "rateLimitExceeded") {
    return { code: "rate_limit", message, retryable: true };
  }
  if (status === 401 || code === 401) {
    return { code: "auth_error", message, retryable: false };
  }
  if (status === 403 || code === 403) {
    return { code: "forbidden", message, retryable: false };
  }
  if (status === 404 || code === 404) {
    return { code: "not_found", message, retryable: false };
  }
  if (status === 400 || code === 400) {
    return { code: "invalid_request", message, retryable: false };
  }
  if (status === 500 || status === 503 || code === 500 || code === 503) {
    return { code: "backend_error", message, retryable: true };
  }

  return { code: "unknown", message, retryable: false };
}

export function toSheetsError(error: unknown): SheetsError {
  return error instanceof SheetsError
    ? error
    : new SheetsError(classifySheetsError(error));
}
