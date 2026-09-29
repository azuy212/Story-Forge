import { describe, it, expect, jest, afterEach } from "@jest/globals";
import {
  parseArgs,
  drainStream,
  runStream,
  resumeRun,
} from "../scripts/resume.mjs";

// Mock the logger to avoid dist import issues in tests
jest.unstable_mockModule("../dist/utils/logger.js", () => ({
  logger: {
    setRunContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    nodeStart: jest.fn(),
    nodeDone: jest.fn(),
    nodePhase: jest.fn(),
    nodeRetry: jest.fn(),
    nodeSkipped: jest.fn(),
    nodeIncomplete: jest.fn(),
    nodeFailed: jest.fn(),
    finalize: jest.fn(),
  },
}));

describe("parseArgs", () => {
  it("parses namespace, pillar, topic and dry-run", () => {
    expect(
      parseArgs(["ns", "--pillar", "Psychology", "--topic", "T", "--dry-run"]),
    ).toEqual({
      namespace: "ns",
      pillar: "Psychology",
      topic: "T",
      profile: null,
      seed: null,
      dryRun: true,
      resetQaRetries: false,
      injectArtifacts: null,
      help: false,
    });
  });

  it("parses --reset-qa-retries", () => {
    const parsed = parseArgs(["ns", "--reset-qa-retries"]);
    expect(parsed.resetQaRetries).toBe(true);
    expect(parsed.dryRun).toBe(false);
  });

  it("parses a single --inject-artifact as type=path", () => {
    expect(
      parseArgs(["ns", "--inject-artifact", "promptQA=./prompt-qa.json"]),
    ).toEqual(
      expect.objectContaining({
        injectArtifacts: { promptQA: "./prompt-qa.json" },
      }),
    );
  });

  it("collects repeated --inject-artifact flags for the same type into an array", () => {
    const parsed = parseArgs([
      "ns",
      "--inject-artifact",
      "subtitles=./a.json",
      "--inject-artifact",
      "subtitles=./b.json",
      "--inject-artifact",
      "promptQA=./p.json",
    ]);
    expect(parsed.injectArtifacts).toEqual({
      subtitles: ["./a.json", "./b.json"],
      promptQA: "./p.json",
    });
  });

  it("allows = inside the path portion of --inject-artifact", () => {
    const parsed = parseArgs([
      "ns",
      "--inject-artifact",
      "scriptQA=/tmp/a=b.json",
    ]);
    expect(parsed.injectArtifacts).toEqual({
      scriptQA: "/tmp/a=b.json",
    });
  });

  it("rejects malformed --inject-artifact values", () => {
    expect(() => parseArgs(["ns", "--inject-artifact"])).toThrow(
      "--inject-artifact requires a value of the form <type>=<path>",
    );
    expect(() => parseArgs(["ns", "--inject-artifact", "no-equals"])).toThrow(
      "--inject-artifact requires <type>=<path>",
    );
    expect(() => parseArgs(["ns", "--inject-artifact", "=path.json"])).toThrow(
      "--inject-artifact requires <type>=<path>",
    );
    expect(() => parseArgs(["ns", "--inject-artifact", "type="])).toThrow(
      "--inject-artifact requires <type>=<path>",
    );
  });

  it("sets help for --help or -h anywhere in the args", () => {
    expect(parseArgs(["ns", "--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("Unknown argument: --bogus");
    expect(() => parseArgs(["ns", "--bogus"])).toThrow(
      "Unknown argument: --bogus",
    );
  });

  it("rejects a second positional argument", () => {
    expect(() => parseArgs(["ns", "other"])).toThrow("Unknown argument: other");
  });

  it("requires values for --pillar and --topic", () => {
    expect(() => parseArgs(["--pillar"])).toThrow("--pillar requires a value");
    expect(() => parseArgs(["--topic"])).toThrow("--topic requires a value");
    expect(() => parseArgs(["--pillar", "--dry-run"])).toThrow(
      "--pillar requires a value",
    );
  });
});

const sse = (...events: object[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const completeEvent = {
  event: "values",
  data: { execution: { status: "complete" } },
};

describe("drainStream", () => {
  it("resolves with the terminal event on a complete run", async () => {
    const seen: object[] = [];
    const { lastEvent } = await drainStream(sse(completeEvent), {
      onEvent: (e) => seen.push(e),
    });
    expect(lastEvent.data.execution.status).toBe("complete");
    expect(seen).toEqual([completeEvent]);
  });

  it("throws on an explicit graph error event", async () => {
    await expect(
      drainStream(sse({ event: "error", data: { error: "boom" } })),
    ).rejects.toThrow("Graph run failed");
  });

  it("throws when execution.status is failed", async () => {
    await expect(
      drainStream(
        sse({
          event: "values",
          data: {
            execution: { status: "failed" },
            diagnostics: { errors: ["analysis failed"] },
          },
        }),
      ),
    ).rejects.toThrow("Graph run failed: analysis failed");
  });

  it("cancels the stream on an error event so the socket is released", async () => {
    let cancelCount = 0;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ event: "error", data: { error: "boom" } })}\n\n`,
          ),
        );
        // Do NOT close: the server keeps the connection open until the
        // client cancels. drainStream must release it on its own.
      },
      cancel() {
        cancelCount++;
      },
    });
    await expect(
      drainStream(new Response(stream, { status: 200 })),
    ).rejects.toThrow("Graph run failed");
    expect(cancelCount).toBe(1);
  });

  it("cancels the stream and returns the last event on a complete run", async () => {
    let cancelCount = 0;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(completeEvent)}\n\n`,
          ),
        );
        // Stay open: drainStream cancels on terminal complete to release
        // the socket instead of waiting for the server to close.
      },
      cancel() {
        cancelCount++;
      },
    });
    const { lastEvent } = await drainStream(
      new Response(stream, { status: 200 }),
    );
    expect(lastEvent.data.execution.status).toBe("complete");
    expect(cancelCount).toBe(1);
  });

  it("cancels the stream if onEvent throws so a buggy callback cannot leak the reader", async () => {
    let cancelCount = 0;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(completeEvent)}\n\n`,
          ),
        );
      },
      cancel() {
        cancelCount++;
      },
    });
    await expect(
      drainStream(new Response(stream, { status: 200 }), {
        onEvent: () => {
          throw new Error("callback boom");
        },
      }),
    ).rejects.toThrow("callback boom");
    expect(cancelCount).toBe(1);
  });

  it("throws on a malformed data event", async () => {
    const res = new Response("data: {not-json}\n\n", { status: 200 });
    await expect(drainStream(res)).rejects.toThrow("Malformed SSE data event");
  });

  it("ignores SSE keep-alive comment lines", async () => {
    const res = new Response(
      `: keep-alive\ndata: ${JSON.stringify(completeEvent)}\n\n`,
      { status: 200 },
    );
    const { lastEvent } = await drainStream(res);
    expect(lastEvent.data.execution.status).toBe("complete");
  });

  it("handles a JSON event split across multiple chunks", async () => {
    const payload = `data: ${JSON.stringify(completeEvent)}`;
    const parts = [payload.slice(0, 17), payload.slice(17)];
    const stream = new ReadableStream({
      start(controller) {
        for (const part of parts)
          controller.enqueue(new TextEncoder().encode(part));
        controller.enqueue(new TextEncoder().encode("\n\n"));
        controller.close();
      },
    });
    const { lastEvent } = await drainStream(
      new Response(stream, { status: 200 }),
    );
    expect(lastEvent.data.execution.status).toBe("complete");
  });

  it("throws when a final chunk is truncated mid-JSON", async () => {
    const payload = `data: ${JSON.stringify(completeEvent)}`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload.slice(0, 30)));
        controller.enqueue(new TextEncoder().encode("\n\n"));
        controller.close();
      },
    });
    await expect(
      drainStream(new Response(stream, { status: 200 })),
    ).rejects.toThrow("Malformed SSE data event");
  });
});

describe("runStream", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts config.configurable.runId and thread_id", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await runStream(
      "thread-1",
      "ast-1",
      { project: { pillar: "P", topic: "T" } },
      "my-run",
      "http://dev",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://dev/threads/thread-1/runs/stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          assistant_id: "ast-1",
          input: { project: { pillar: "P", topic: "T" } },
          config: { configurable: { runId: "my-run", thread_id: "thread-1" } },
          multitask_strategy: "interrupt",
          stream_mode: ["events", "values"],
        }),
      }),
    );
  });

  it("throws on HTTP failure before streaming", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      runStream("thread-1", "ast-1", {}, "my-run", "http://dev"),
    ).rejects.toThrow("Run stream failed: 500");
  });

  it("adds manualArtifacts and manualArtifactProfile to config.configurable when provided", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await runStream(
      "thread-1",
      "ast-1",
      { project: { pillar: "P", topic: "T" } },
      "my-run",
      "http://dev",
      {
        manualArtifacts: { promptQA: "/abs/prompt-qa.json" },
        manualArtifactProfile: "long",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://dev/threads/thread-1/runs/stream",
      expect.objectContaining({
        body: JSON.stringify({
          assistant_id: "ast-1",
          input: { project: { pillar: "P", topic: "T" } },
          config: {
            configurable: {
              runId: "my-run",
              thread_id: "thread-1",
              manualArtifacts: { promptQA: "/abs/prompt-qa.json" },
              manualArtifactProfile: "long",
            },
          },
          multitask_strategy: "interrupt",
          stream_mode: ["events", "values"],
        }),
      }),
    );
  });
});

describe("resumeRun", () => {
  it("fails closed: does not start the run if thread recording fails", async () => {
    const runStreamMock = jest.fn<typeof runStream>();
    const createThreadMock = jest
      .fn<() => Promise<{ thread_id: string }>>()
      .mockResolvedValue({ thread_id: "t-new" });
    const recordThread = jest
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValue(new Error("disk full"));

    await expect(
      resumeRun(
        "ns",
        { pillar: "P", topic: "T" },
        {
          assistantId: "ast-1",
          createThread: createThreadMock,
          runStream: runStreamMock,
          recordThread,
        },
      ),
    ).rejects.toThrow("disk full");

    expect(createThreadMock).toHaveBeenCalledTimes(1);
    expect(recordThread).toHaveBeenCalledWith("t-new");
    expect(runStreamMock).not.toHaveBeenCalled();
  });

  it("records the thread before starting the run and returns the terminal event", async () => {
    const runStreamMock = jest
      .fn<typeof runStream>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const drainStreamMock = jest
      .fn<
        () => Promise<{
          lastEvent: {
            event: string;
            data: { execution: { status: string } };
          };
        }>
      >()
      .mockResolvedValue({
        lastEvent: {
          event: "values",
          data: { execution: { status: "complete" } },
        },
      });
    const createThreadMock = jest
      .fn<() => Promise<{ thread_id: string }>>()
      .mockResolvedValue({ thread_id: "t-new" });
    const recordThread = jest
      .fn<(threadId: string) => Promise<void>>()
      .mockResolvedValue(undefined);

    const result = await resumeRun(
      "ns",
      { pillar: "P", topic: "T" },
      {
        assistantId: "ast-1",
        createThread: createThreadMock,
        runStream: runStreamMock,
        drainStream: drainStreamMock,
        recordThread,
      },
    );

    expect(recordThread).toHaveBeenCalledWith("t-new");
    expect(runStreamMock).toHaveBeenCalledWith(
      "t-new",
      "ast-1",
      { project: { pillar: "P", topic: "T" } },
      "ns",
      undefined,
      { manualArtifacts: null, manualArtifactProfile: null },
    );
    expect(result).toEqual({
      threadId: "t-new",
      lastEvent: {
        event: "values",
        data: { execution: { status: "complete" } },
      },
    });
  });

  it("forwards manualArtifacts and manualArtifactProfile to runStream", async () => {
    const runStreamMock = jest
      .fn<typeof runStream>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const drainStreamMock = jest
      .fn<
        () => Promise<{
          lastEvent: {
            event: string;
            data: { execution: { status: string } };
          };
        }>
      >()
      .mockResolvedValue({
        lastEvent: {
          event: "values",
          data: { execution: { status: "complete" } },
        },
      });
    const createThreadMock = jest
      .fn<() => Promise<{ thread_id: string }>>()
      .mockResolvedValue({ thread_id: "t-new" });
    const recordThread = jest
      .fn<(threadId: string) => Promise<void>>()
      .mockResolvedValue(undefined);

    await resumeRun(
      "ns",
      { pillar: "P", topic: "T" },
      {
        assistantId: "ast-1",
        createThread: createThreadMock,
        runStream: runStreamMock,
        drainStream: drainStreamMock,
        recordThread,
        manualArtifacts: { promptQA: "/abs/prompt-qa.json" },
        manualArtifactProfile: "long",
      },
    );

    expect(runStreamMock).toHaveBeenCalledWith(
      "t-new",
      "ast-1",
      { project: { pillar: "P", topic: "T" } },
      "ns",
      undefined,
      {
        manualArtifacts: { promptQA: "/abs/prompt-qa.json" },
        manualArtifactProfile: "long",
      },
    );
  });
});
