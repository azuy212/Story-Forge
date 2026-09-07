import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type OpenAI from "openai";
import {
  generateWithStreamTimeouts,
  createModel,
  type LlmStreamTimeoutOptions,
} from "../src/models/model-factory.js";
import { AgentModel } from "../src/models/agent-model.js";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

const abortError = new DOMException("aborted", "AbortError");

function chunk(
  over: Partial<OpenAI.Chat.Completions.ChatCompletionChunk> = {},
): Chunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    ...over,
  } as Chunk;
}

function contentChunk(text: string): Chunk {
  return chunk({
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
}

/**
 * Build an async-iterable stream that yields chunks on a delay schedule and
 * rejects with an AbortError once the helper's signal aborts mid-wait.
 */
function scheduleStream(
  signal: AbortSignal,
  schedule: Array<{ delay: number; chunk?: Chunk }>,
): AsyncIterable<Chunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of schedule) {
        if (signal.aborted) throw abortError;
        await Promise.race([
          new Promise<"timer">((resolve) =>
            setTimeout(() => resolve("timer"), item.delay),
          ),
          new Promise<"abort">((_, reject) => {
            signal.addEventListener("abort", () => reject(abortError), {
              once: true,
            });
          }),
        ]);
        if (item.chunk) yield item.chunk;
      }
    },
  };
}

function streamThatHangs(signal: AbortSignal): AsyncIterable<Chunk> {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) throw abortError;
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(abortError), {
          once: true,
        });
      });
    },
  };
}

const timeouts: LlmStreamTimeoutOptions = {
  firstTokenTimeoutMs: 1000,
  streamInactivityTimeoutMs: 2000,
};

describe("generateWithStreamTimeouts", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("aborts after first-token timeout when no chunk ever arrives", async () => {
    const promise = generateWithStreamTimeouts(
      (signal) => Promise.resolve(streamThatHangs(signal)),
      timeouts,
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("first token"),
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("aborts when createStream() itself never resolves until the signal fires", async () => {
    const createStream = (signal: AbortSignal) =>
      new Promise<AsyncIterable<Chunk>>((_, reject) => {
        signal.addEventListener("abort", () => reject(abortError), {
          once: true,
        });
      });
    const promise = generateWithStreamTimeouts(createStream, timeouts);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("first token"),
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cancels the first-token timer once the first chunk arrives just before the timeout", async () => {
    const promise = generateWithStreamTimeouts(
      (signal) =>
        Promise.resolve(
          scheduleStream(signal, [
            { delay: 950, chunk: contentChunk("hello") },
            { delay: 500, chunk: contentChunk(" world") },
          ]),
        ),
      timeouts,
    );
    await jest.advanceTimersByTimeAsync(950);
    await jest.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toEqual(
      expect.objectContaining({ text: "hello world" }),
    );
    await jest.advanceTimersByTimeAsync(5000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps a chunking stream alive beyond any fixed total timeout", async () => {
    const longInterval: LlmStreamTimeoutOptions = {
      firstTokenTimeoutMs: 1000,
      streamInactivityTimeoutMs: 120_000,
    };
    const schedule = [
      { delay: 100, chunk: contentChunk("a") },
      { delay: 100_000, chunk: contentChunk("b") },
      { delay: 100_000, chunk: contentChunk("c") },
      { delay: 100_000, chunk: contentChunk("d") },
      { delay: 100_000, chunk: contentChunk("e") },
      { delay: 100_000, chunk: contentChunk("f") },
      { delay: 100_000, chunk: contentChunk("g") },
      { delay: 100_000, chunk: contentChunk("h") },
    ];
    const promise = generateWithStreamTimeouts(
      (signal) => Promise.resolve(scheduleStream(signal, schedule)),
      longInterval,
    );
    await jest.advanceTimersByTimeAsync(100);
    for (let i = 1; i < schedule.length; i++) {
      await jest.advanceTimersByTimeAsync(100_000);
    }
    // Total elapsed ~700s, still alive past the old 600s fixed cap.
    await expect(promise).resolves.toEqual(
      expect.objectContaining({ text: "abcdefgh" }),
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it("aborts when the stream goes inactive between chunks", async () => {
    const promise = generateWithStreamTimeouts(
      (signal) =>
        Promise.resolve(
          scheduleStream(signal, [
            { delay: 0, chunk: contentChunk("start") },
            { delay: 3000 },
          ]),
        ),
      timeouts,
    );
    const assertion = expect(promise).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("stalled"),
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(2000);
    await assertion;
    await jest.advanceTimersByTimeAsync(1000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("captures id, model, and usage from stream chunks", async () => {
    const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
    const promise = generateWithStreamTimeouts(
      (signal) =>
        Promise.resolve(
          scheduleStream(signal, [
            { delay: 0, chunk: chunk({ choices: [], usage }) },
          ]),
        ),
      timeouts,
    );
    await jest.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toEqual({
      text: "",
      id: "chunk-1",
      model: "test-model",
      usage,
    });
  });

  it("passes through a provider error raised before streaming begins", async () => {
    const providerError = Object.assign(new Error("provider unavailable"), {
      status: 503,
    });
    const createStream = () => Promise.reject(providerError);
    const promise = generateWithStreamTimeouts(createStream, timeouts);
    const assertion = expect(promise).rejects.toThrow("provider unavailable");
    const notTimeout = expect(promise).rejects.not.toMatchObject({
      name: "TimeoutError",
    });
    await assertion;
    await notTimeout;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("passes through a provider error raised after streaming begins", async () => {
    const promise = generateWithStreamTimeouts(
      (signal) =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield contentChunk("partial");
            throw new Error("mid-stream failure");
          },
        }),
      timeouts,
    );
    const assertion = expect(promise).rejects.toThrow("mid-stream failure");
    const notTimeout = expect(promise).rejects.not.toMatchObject({
      name: "TimeoutError",
    });
    await jest.advanceTimersByTimeAsync(0);
    await assertion;
    await notTimeout;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("passes through a provider-generated AbortError unchanged (not TimeoutError)", async () => {
    const promise = generateWithStreamTimeouts(
      (signal) =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield contentChunk("partial");
            throw abortError;
          },
        }),
      timeouts,
    );
    const assertion = expect(promise).rejects.toThrow("aborted");
    const notTimeout = expect(promise).rejects.not.toMatchObject({
      name: "TimeoutError",
    });
    await jest.advanceTimersByTimeAsync(0);
    await assertion;
    await notTimeout;
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("createModel streaming request", () => {
  it("sends a streaming request and accumulates/normalizes the response", async () => {
    const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
    const create = jest.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield contentChunk("hel");
        yield contentChunk("lo");
        yield chunk({ choices: [], usage });
      },
    }));
    const fakeClient = {
      chat: { completions: { create } },
    };
    const model = createModel(AgentModel.ScriptWriter, {
      client: fakeClient as unknown as OpenAI,
    });

    const result = await model.generate([{ role: "user", content: "hello" }], {
      temperature: 0.5,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.5,
      }),
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(result.output).toBe("hello");
    expect(result.usage?.provider).toBe("openrouter");
    expect(result.usage?.promptTokens).toBe(5);
    expect(result.usage?.completionTokens).toBe(3);
    expect(result.usage?.totalTokens).toBe(8);
    expect(result.usage?.model).toBe("test-model");
    expect(model.model).toBe("z-ai/glm-5.3-flash");
  });
});
