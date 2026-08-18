export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  timeout: number;
  onRetry?: (error: Error, attempt: number) => void;
  /** When provided, a false verdict rethrows immediately instead of retrying. */
  isRetryable?: (error: Error) => boolean;
}

export class RetryError extends Error {
  public readonly attempts: number;

  constructor(message: string, attempts: number) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
  }
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, baseDelayMs, onRetry, isRetryable } = options;
  const errors: Error[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      errors.push(err);

      if (isRetryable && !isRetryable(err)) {
        throw err;
      }

      if (attempt === maxAttempts) {
        throw new RetryError(
          `Operation failed after ${maxAttempts} attempts: ${err.message}`,
          maxAttempts,
        );
      }

      if (onRetry) {
        onRetry(err, attempt);
      }

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs, 30000);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('Unreachable');
}
