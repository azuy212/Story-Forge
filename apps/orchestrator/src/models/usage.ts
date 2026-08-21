import { randomUUID } from "node:crypto";

/**
 * Normalized LLM token-usage/cost record. Provider-specific shapes
 * (OpenRouter extras, streaming final-chunk usage) are mapped here, once, at
 * the model boundary. All numeric fields optional: providers can omit them
 * and a value is never fabricated.
 */
export interface LLMUsage {
  provider: string;
  model: string;
  /** Provider-assigned request id (OpenRouter response id), when available. */
  requestId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Prompt tokens served from the provider's cache. */
  cachedTokens?: number;
  /** Prompt tokens written into the provider's cache. */
  cacheWriteTokens?: number;
  /** Reasoning/thinking completion tokens, when the provider reports them. */
  reasoningTokens?: number;
  /** Cost in USD reported by the provider, when available. */
  costUsd?: number;
  timestamp: string;
}

/** Normalized result of one model request: output plus usage (if reported). */
export interface LLMResult<T> {
  output: T;
  usage?: LLMUsage;
}

/** Per-model breakdown of an aggregated run. */
export interface LLMModelUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

/** Aggregated LLM usage for one run (or one sheet row). */
export interface LLMAggregate {
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmTotalTokens: number;
  llmReasoningTokens: number;
  llmCachedTokens: number;
  llmCacheWriteTokens: number;
  llmCostUsd?: number;
  llmRequestCount: number;
  llmModels: Record<string, LLMModelUsage>;
}

/**
 * Locally generated id minted BEFORE the model call. Deduplication keys off
 * this, so idempotency never depends on the provider returning an id.
 */
export function newInvocationId(): string {
  return randomUUID();
}

type RawObject = Record<string, unknown>;

function obj(value: unknown): RawObject | undefined {
  return typeof value === "object" && value !== null
    ? (value as RawObject)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Map a provider usage payload to a normalized LLMUsage. Accepts the
 * non-streaming response usage and the streaming final-chunk usage (same
 * field layout). Returns undefined when no usage payload exists; missing
 * individual fields stay undefined rather than being zeroed.
 */
export function normalizeUsage(
  raw: unknown,
  meta: { model: string; requestId?: string },
): LLMUsage | undefined {
  const usage = obj(raw);
  if (!usage) return undefined;

  const promptDetails = obj(usage.prompt_tokens_details);
  const completionDetails = obj(usage.completion_tokens_details);

  const cachedTokens =
    num(promptDetails?.cached_tokens) ?? num(usage.cached_tokens);
  const cacheWriteTokens = num(promptDetails?.cache_write_tokens);
  const reasoningTokens = num(completionDetails?.reasoning_tokens);
  const costUsd = num(usage.cost) ?? num(usage.total_cost);
  const requestId = typeof usage.id === "string" ? usage.id : meta.requestId;

  return {
    provider: "openrouter",
    model: meta.model,
    requestId,
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
    cachedTokens,
    cacheWriteTokens,
    reasoningTokens,
    costUsd,
    timestamp: new Date().toISOString(),
  };
}

/** Sum a set of persisted usage records into one aggregate. */
export function aggregateUsage(records: LLMUsage[]): LLMAggregate {
  const llmModels: Record<string, LLMModelUsage> = {};
  let llmPromptTokens = 0;
  let llmCompletionTokens = 0;
  let llmTotalTokens = 0;
  let llmReasoningTokens = 0;
  let llmCachedTokens = 0;
  let llmCacheWriteTokens = 0;
  let llmCostUsd: number | undefined;

  for (const r of records) {
    llmPromptTokens += r.promptTokens ?? 0;
    llmCompletionTokens += r.completionTokens ?? 0;
    llmTotalTokens += r.totalTokens ?? 0;
    llmReasoningTokens += r.reasoningTokens ?? 0;
    llmCachedTokens += r.cachedTokens ?? 0;
    llmCacheWriteTokens += r.cacheWriteTokens ?? 0;
    if (r.costUsd !== undefined) {
      llmCostUsd = (llmCostUsd ?? 0) + r.costUsd;
    }

    const perModel = (llmModels[r.model] ??= {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    perModel.requests += 1;
    perModel.promptTokens += r.promptTokens ?? 0;
    perModel.completionTokens += r.completionTokens ?? 0;
    perModel.totalTokens += r.totalTokens ?? 0;
    if (r.costUsd !== undefined) {
      perModel.costUsd = (perModel.costUsd ?? 0) + r.costUsd;
    }
  }

  return {
    llmPromptTokens,
    llmCompletionTokens,
    llmTotalTokens,
    llmReasoningTokens,
    llmCachedTokens,
    llmCacheWriteTokens,
    llmCostUsd,
    llmRequestCount: records.length,
    llmModels,
  };
}
