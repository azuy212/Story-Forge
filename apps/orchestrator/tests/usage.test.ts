import { describe, it, expect, jest } from "@jest/globals";
import {
  normalizeUsage,
  aggregateUsage,
  type LLMUsage,
} from "../src/models/usage.js";
import { persistLlmUsage } from "../src/artifacts/usage.js";
import type { RunnableConfig } from "@langchain/core/runnables";

describe("normalizeUsage", () => {
  it("maps OpenRouter non-streaming usage fields", () => {
    const usage = normalizeUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 20 },
        cost: 0.0123,
      },
      { model: "model-x", requestId: "req-1" },
    );
    expect(usage).toMatchObject({
      provider: "openrouter",
      model: "model-x",
      requestId: "req-1",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: 30,
      cacheWriteTokens: 5,
      reasoningTokens: 20,
      costUsd: 0.0123,
    });
    expect(typeof usage?.timestamp).toBe("string");
  });

  it("accepts the streaming final-chunk usage shape", () => {
    const usage = normalizeUsage(
      {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
      { model: "model-x", requestId: "req-2" },
    );
    expect(usage?.totalTokens).toBe(30);
  });

  it("falls back to total_cost and usage.id", () => {
    const usage = normalizeUsage(
      {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        total_cost: 0.5,
        id: "stream-chunk-id",
      },
      { model: "model-x" },
    );
    expect(usage?.costUsd).toBe(0.5);
    expect(usage?.requestId).toBe("stream-chunk-id");
  });

  it("leaves absent fields undefined rather than zeroing them", () => {
    const usage = normalizeUsage({ prompt_tokens: 1 }, { model: "model-x" });
    expect(usage?.completionTokens).toBeUndefined();
    expect(usage?.totalTokens).toBeUndefined();
    expect(usage?.cachedTokens).toBeUndefined();
    expect(usage?.reasoningTokens).toBeUndefined();
    expect(usage?.costUsd).toBeUndefined();
  });

  it("returns undefined when there is no usage payload", () => {
    expect(normalizeUsage(undefined, { model: "m" })).toBeUndefined();
    expect(normalizeUsage(null, { model: "m" })).toBeUndefined();
    expect(normalizeUsage("nope", { model: "m" })).toBeUndefined();
  });
});

function record(overrides: Partial<LLMUsage> = {}): LLMUsage {
  return {
    provider: "openrouter",
    model: "model-x",
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    timestamp: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("aggregateUsage", () => {
  it("sums token totals across multiple requests", () => {
    const agg = aggregateUsage([
      record({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
      record({
        model: "model-x",
        promptTokens: 40,
        completionTokens: 60,
        totalTokens: 100,
      }),
    ]);
    expect(agg.llmPromptTokens).toBe(50);
    expect(agg.llmCompletionTokens).toBe(80);
    expect(agg.llmTotalTokens).toBe(130);
    expect(agg.llmRequestCount).toBe(2);
  });

  it("sums reasoning and cached tokens", () => {
    const agg = aggregateUsage([
      record({ reasoningTokens: 5, cachedTokens: 6, cacheWriteTokens: 1 }),
      record({ reasoningTokens: 7, cachedTokens: 8, cacheWriteTokens: 2 }),
    ]);
    expect(agg.llmReasoningTokens).toBe(12);
    expect(agg.llmCachedTokens).toBe(14);
    expect(agg.llmCacheWriteTokens).toBe(3);
  });

  it("sums cost only over records that report it", () => {
    const agg = aggregateUsage([
      record({ costUsd: 0.01 }),
      record({ costUsd: 0.02 }),
      record({ costUsd: undefined }),
    ]);
    expect(agg.llmCostUsd).toBe(0.03);
  });

  it("leaves cost undefined when no record reports it", () => {
    const agg = aggregateUsage([record(), record()]);
    expect(agg.llmCostUsd).toBeUndefined();
  });

  it("breaks down usage per model", () => {
    const agg = aggregateUsage([
      record({
        model: "model-a",
        promptTokens: 10,
        totalTokens: 30,
        costUsd: 0.01,
      }),
      record({
        model: "model-a",
        promptTokens: 20,
        totalTokens: 60,
        costUsd: 0.02,
      }),
      record({ model: "model-b", promptTokens: 5, totalTokens: 15 }),
    ]);
    expect(agg.llmModels["model-a"]).toEqual({
      requests: 2,
      promptTokens: 30,
      completionTokens: 40,
      totalTokens: 90,
      costUsd: 0.03,
    });
    expect(agg.llmModels["model-b"]).toEqual({
      requests: 1,
      promptTokens: 5,
      completionTokens: 20,
      totalTokens: 15,
      costUsd: undefined,
    });
  });

  it("aggregates records from multiple nodes into one run total", () => {
    const agg = aggregateUsage([
      record({ model: "model-a", promptTokens: 10, totalTokens: 30 }),
      record({ model: "model-b", promptTokens: 20, totalTokens: 60 }),
    ]);
    expect(agg.llmTotalTokens).toBe(90);
    expect(agg.llmRequestCount).toBe(2);
  });
});

function makeStore() {
  const saved: Array<Record<string, unknown>> = [];
  const byHash = new Map<string, unknown>();
  const store = {
    saved,
    findCompleteByInputHash: jest.fn(
      async (_runId: string, _type: string, inputHash: string) =>
        byHash.has(inputHash)
          ? { record: byHash.get(inputHash), ref: {} }
          : null,
    ),
    save: jest.fn(
      async (
        _runId: string,
        _type: string,
        value: unknown,
        meta: Record<string, unknown>,
      ) => {
        saved.push({ value, meta });
        byHash.set(meta.inputHash as string, { ...(value as object) });
        return {
          artifactId: "a-1",
          type: _type,
          version: saved.length,
          location: "",
          runId: _runId,
        };
      },
    ),
  };
  return store;
}

function configWith(store: unknown): RunnableConfig {
  return {
    configurable: { runId: "run-1", artifactStore: store },
  } as RunnableConfig;
}

describe("persistLlmUsage", () => {
  it("saves a record with runId/node/attempt/invocationId", async () => {
    const store = makeStore();
    await persistLlmUsage(
      configWith(store),
      { node: "ScriptWriter", attempt: 1, invocationId: "inv-1" },
      record(),
    );
    expect(store.saved).toHaveLength(1);
    const value = store.saved[0].value as Record<string, unknown>;
    expect(value.runId).toBe("run-1");
    expect(value.node).toBe("ScriptWriter");
    expect(value.attempt).toBe(1);
    expect(value.invocationId).toBe("inv-1");
  });

  it("does not duplicate a record for the same invocation (resume idempotency)", async () => {
    const store = makeStore();
    const ctx = { node: "ScriptWriter", attempt: 1, invocationId: "inv-1" };
    await persistLlmUsage(configWith(store), ctx, record());
    await persistLlmUsage(configWith(store), ctx, record());
    expect(store.saved).toHaveLength(1);
  });

  it("saves nothing when usage is missing", async () => {
    const store = makeStore();
    await persistLlmUsage(
      configWith(store),
      { node: "ScriptWriter", attempt: 1, invocationId: "inv-1" },
      undefined,
    );
    expect(store.saved).toHaveLength(0);
  });

  it("is a no-op without an artifact store", async () => {
    await persistLlmUsage(
      {
        configurable: { runId: "run-1", artifactStoreEnabled: false },
      } as RunnableConfig,
      { node: "ScriptWriter", attempt: 1, invocationId: "inv-1" },
      record(),
    );
    expect(true).toBe(true);
  });

  it("never throws when the store fails", async () => {
    const store = {
      findCompleteByInputHash: jest.fn(async () => {
        throw new Error("boom");
      }),
      save: jest.fn(),
    };
    await expect(
      persistLlmUsage(
        configWith(store),
        { node: "ScriptWriter", attempt: 1, invocationId: "inv-1" },
        record(),
      ),
    ).resolves.toBeUndefined();
  });
});
