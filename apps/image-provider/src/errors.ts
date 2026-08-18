/**
 * Normalized image-provider failure type. The provider boundary owns
 * classification: nothing downstream sees Gemini-specific messages.
 */
export type ProviderErrorType =
  | 'content_policy'
  | 'invalid_prompt'
  | 'rate_limit'
  | 'timeout'
  | 'server_error'
  | 'authentication'
  | 'invalid_request'
  | 'unknown';

/**
 * `invalid_request` is declared for contract symmetry with the orchestrator
 * (HTTP 400 / fatal) but is not currently produced by the Gemini adapter.
 * Reserved for requests that are malformed at the provider boundary.
 */

/** Types that may recover from a same-prompt retry. */
const RETRYABLE_TYPES: ReadonlySet<ProviderErrorType> = new Set<ProviderErrorType>([
  'rate_limit',
  'timeout',
  'server_error',
]);

export function isRetryableType(type: ProviderErrorType): boolean {
  return RETRYABLE_TYPES.has(type);
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly type: ProviderErrorType,
    public readonly rawMessage?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Deterministic, ordered classifier for Gemini UI error text. Group order is
 * significant:
 * - content_policy is checked first so a policy rejection can never be
 *   downgraded to server_error (a policy rejection must repair, never retry).
 * - server_error is checked before invalid_prompt so generic operational
 *   phrasing like "try again" / "something went wrong" never routes to prompt
 *   repair.
 * Patterns are derived from the actual message patterns surfaced by
 * `detectGenerationError` in gemini-client, not hand-written guesswork.
 */
const CLASSIFIER: ReadonlyArray<{ type: ProviderErrorType; patterns: string[] }> = [
  {
    type: 'content_policy',
    patterns: [
      'content policy',
      'violation',
      'blocked',
      'public figure',
      "can't depict",
      'cannot depict',
      'refuse',
      'refused',
      'not allowed',
      'flagge',
      'against our',
      'not permitted',
    ],
  },
  {
    type: 'rate_limit',
    patterns: ['rate limit', 'rate-limited', 'too many requests', 'quota'],
  },
  {
    type: 'timeout',
    patterns: ['timeout', 'timed out', 'took too long'],
  },
  {
    type: 'authentication',
    patterns: [
      'sign in',
      'log in',
      'login',
      'authentication',
      'authenticate',
      'permission',
      'authorized',
    ],
  },
  {
    type: 'server_error',
    patterns: [
      'image generation failed',
      'image generation error',
      'failed to generate',
      'something went wrong',
      'encountered an error',
      'not available',
      'unavailable',
    ],
  },
  {
    type: 'invalid_prompt',
    patterns: [
      "can't generate",
      'cannot generate',
      "couldn't generate",
      'unable to generate',
      'invalid prompt',
      'unsupported prompt',
      'no assets generated',
      'prompt rejected',
    ],
  },
];

const NORMALIZED = /[\s_]+/g;
const lower = (message: string): string => message.toLowerCase().replace(NORMALIZED, ' ');

/**
 * Infrastructure failure markers checked BEFORE the classifier groups. The
 * groups below use substring matching (e.g. content_policy catches "refused
 * to generate"), which would misclassify transport failures like
 * `net::ERR_CONNECTION_REFUSED` as prompt rejections. Anything that smells
 * like a network/connection failure is pinned to server_error first.
 */
const INFRASTRUCTURE_PATTERNS = [
  'net::err',
  'econn',
  'connection refused',
  'connection reset',
  'socket hang up',
  'getaddrinfo',
  'failed to fetch',
  'fetch failed',
  'request failed',
  'dns',
  'network error',
];

export function classifyGeminiError(message: string): ProviderErrorType {
  const normalized = lower(message);
  if (normalized.length === 0) return 'unknown';
  if (INFRASTRUCTURE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return 'server_error';
  }
  for (const group of CLASSIFIER) {
    if (group.patterns.some((pattern) => normalized.includes(pattern))) {
      return group.type;
    }
  }
  return 'unknown';
}

/**
 * Convert an arbitrary thrown value from the Gemini generation path into a
 * ProviderError. Bare Error instances are classified by message text;
 * already-classified ProviderErrors pass through unchanged.
 */
export function toProviderError(error: unknown, fallbackMessage: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(
    message || fallbackMessage,
    classifyGeminiError(message),
    message || fallbackMessage,
  );
}
