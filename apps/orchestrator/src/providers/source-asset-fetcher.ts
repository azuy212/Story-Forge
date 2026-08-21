export interface FetchRetryOptions {
  timeoutMs: number;
  deadlineMs?: number;
  retryDelaysMs: readonly number[];
}

interface RetryDecision {
  shouldRetry: boolean;
  reason: string;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function classifyError(err: unknown, status?: number): RetryDecision {
  if (isAbortError(err)) {
    return { shouldRetry: false, reason: "timeout" };
  }
  if (err instanceof TypeError && err.message.includes("fetch failed")) {
    const cause = err.cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = String((cause as Record<string, unknown>).code);
      if (
        [
          "ENOTFOUND",
          "EAI_AGAIN",
          "ECONNRESET",
          "ECONNREFUSED",
          "ETIMEDOUT",
        ].includes(code)
      ) {
        return { shouldRetry: true, reason: `network:${code}` };
      }
    }
    return { shouldRetry: true, reason: "network:fetch_failed" };
  }
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (
      [
        "enotfound",
        "eai_again",
        "econnreset",
        "econnrefused",
        "etimedout",
      ].some((c) => message.includes(c))
    ) {
      return { shouldRetry: true, reason: `network:${message}` };
    }
  }
  if (typeof status === "number") {
    if (status === 429 || status >= 500) {
      return { shouldRetry: true, reason: `http:${status}` };
    }
    if (status >= 400) {
      return { shouldRetry: false, reason: `http:${status}` };
    }
  }
  return { shouldRetry: false, reason: "unknown" };
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions,
): Promise<Response> {
  const { timeoutMs, deadlineMs, retryDelaysMs } = opts;
  const maxAttempts = retryDelaysMs.length + 1;
  let attempt = 0;
  let lastError: unknown;
  let lastStatus: number | undefined;

  const remainingBudget = (): number =>
    deadlineMs === undefined ? Infinity : deadlineMs - Date.now();

  while (attempt < maxAttempts) {
    const budget = remainingBudget();
    if (budget <= 0) throw new Error("deadline_exceeded");
    const attemptTimeout = Math.min(timeoutMs, budget);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);
    const signal = controller.signal;

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      const decision = classifyError(err);
      if (!decision.shouldRetry || attempt >= maxAttempts - 1) {
        throw new Error(
          `Fetch failed after ${attempt + 1} attempt(s): ${decision.reason}`,
          { cause: err },
        );
      }
      lastStatus = undefined;
      const delay = retryDelaysMs[attempt];
      if (remainingBudget() <= delay) {
        throw new Error("deadline_exceeded", { cause: err });
      }
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
      continue;
    }

    clearTimeout(timeoutId);
    lastStatus = response.status;

    if (!response.ok) {
      const decision = classifyError(null, response.status);
      if (!decision.shouldRetry || attempt >= maxAttempts - 1) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${decision.reason}`,
        );
      }
      const delay = retryDelaysMs[attempt];
      if (remainingBudget() <= delay) throw new Error("deadline_exceeded");
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
      continue;
    }

    return response;
  }

  const finalReason =
    lastStatus !== undefined
      ? `http:${lastStatus}`
      : classifyError(lastError).reason;
  throw new Error(`Fetch failed after ${maxAttempts} attempts: ${finalReason}`);
}
