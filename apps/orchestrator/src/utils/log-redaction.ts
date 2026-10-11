/**
 * Logging hygiene helpers shared by the orchestrator's log surfaces.
 *
 * Two rules, one implementation:
 *
 * 1. Secrets never reach a log. Provider keys (OpenRouter, Pexels, Google),
 *    bearer tokens, and `key = value` style config dumps are redacted before
 *    anything is written, so a stray `logger.debug(env)` or a prompt that
 *    quotes a key cannot leak it.
 * 2. Echoes are capped. Debug payload dumps and provider response bodies are
 *    truncated to a bounded number of characters with explicit markers, so the
 *    log file cannot grow without limit and a whole script cannot be
 *    accidentally dumped.
 *
 * Both functions are total: they must never throw, because they run on error
 * paths where the original value is already the problem.
 */

/** Default cap for an inline echo of a prompt/response. */
export const LOG_TEXT_LIMIT = 2000;

/** Larger cap for structured provider bodies that are worth reading whole. */
export const LOG_BODY_LIMIT = 8000;

const REDACTED = "[redacted]";

// Provider-style API keys: OpenRouter/OpenAI (sk-...), Google (AIza...).
const KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b(?:gsk|ghp|xox[baprs])-[A-Za-z0-9-]{16,}\b/g,
];

// `name: value` / `name=value` pairs where the name marks a secret. Values are
// matched up to a delimiter so a long config dump redacts each entry.
const SECRET_FIELD =
  /((?:api[_-]?key|apikey|access[_-]?key|secret|client[_-]?secret|refresh[_-]?token|password|authorization)\s*[:=]\s*)([^\s,;"'}{]+)/gi;

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  out = out.replace(SECRET_FIELD, (_match, name: string) => `${name}${REDACTED}`);
  return out;
}

export interface TruncateOptions {
  maxChars?: number;
  marker?: string;
}

/**
 * Cap `text` to `maxChars`, appending an explicit marker that records how much
 * was removed. Never returns a string longer than the cap plus the marker.
 */
export function truncateForLog(
  text: string,
  { maxChars = LOG_TEXT_LIMIT, marker = "…[truncated]" }: TruncateOptions = {},
): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}${marker} (${text.length - maxChars} more chars)`;
}

/** Redact, then truncate — the order every log call should use. */
export function sanitizeForLog(
  text: string,
  options: TruncateOptions = {},
): string {
  return truncateForLog(redactSecrets(text), options);
}

/** Same as `sanitizeForLog`, but tolerates non-string values. */
export function sanitizeUnknownForLog(
  value: unknown,
  options: TruncateOptions = {},
): string {
  if (typeof value === "string") return sanitizeForLog(value, options);
  try {
    return sanitizeForLog(JSON.stringify(value) ?? String(value), options);
  } catch {
    return "<unserializable>";
  }
}
