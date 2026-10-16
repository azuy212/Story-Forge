/**
 * The provider HTTP error envelope, parsed in ONE place.
 *
 * Every service behind the orchestrator (TTS, transcriber, image provider)
 * reports failures as:

 *   { "error": { "code", "message", "requestId", ... } }
 *
 * `code` is the stable machine-readable failure id, `message` is caller-safe
 * (never a file path or a stack trace), and `requestId` correlates the failure
 * with the service's own logs. Services may add their own keys — the image
 * provider carries `type`/`provider`/`model`/`retryable` — which consumers read
 * from the returned record; nothing here hard-codes a service.
 *
 * See the Provider HTTP Contracts section in AGENTS.md.
 */

export interface ServiceError {
  code: string;
  message: string;
  requestId?: string;
  /** Any extra service-specific fields, preserved verbatim for the consumer. */
  details: Record<string, unknown>;
}

/** Shape of the parsed envelope before normalization. */
interface RawEnvelope {
  error?: {
    code?: unknown;
    type?: unknown;
    message?: unknown;
    requestId?: unknown;
    detail?: unknown;
    [key: string]: unknown;
  } | null;
  detail?: unknown;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a service error body. Returns null when the body is not the shared
 * envelope (so callers can fall back to HTTP status), never throws on
 * non-JSON or unexpected shapes.
 *
 * `type` is accepted as an alias for `code`: the image provider has always
 * used `type` as its machine-readable failure id, and forcing a rename would
 * break its existing contract for no gain.
 */
export function parseServiceErrorEnvelope(
  body: unknown,
): ServiceError | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as RawEnvelope;
  const error = raw.error;
  if (typeof error !== "object" || error === null) return null;

  const code = asTrimmedString(error.code) ?? asTrimmedString(error.type);
  const message = asTrimmedString(error.message);
  if (!code && !message) return null;

  return {
    code: code ?? "UNKNOWN",
    message: message ?? `request failed (${code ?? "unknown error"})`,
    requestId: asTrimmedString(error.requestId),
    details: error,
  };
}

/**
 * Read a non-ok response as the shared envelope. Never throws: a body that is
 * missing or not JSON yields null so the caller keeps its HTTP-status message.
 */
export async function readServiceError(
  response: Response,
): Promise<ServiceError | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return parseServiceErrorEnvelope(body);
}

/**
 * One-line failure description for a PipelineError, carrying the service's own
 * code and correlation id instead of just the HTTP status:
 *
 *   "TTS synthesis failed [ENGINE_FAILURE]: TTS generation failed. (requestId 0f3c1d9b)"
 */
export function describeServiceFailure(
  verb: string,
  error: ServiceError | null,
  httpFallback: string,
): string {
  if (!error) return `${verb}: ${httpFallback}`;
  const suffix = error.requestId ? ` (requestId ${error.requestId})` : "";
  return `${verb} [${error.code}]: ${error.message}${suffix}`;
}
