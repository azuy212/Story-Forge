import { describe, it, expect, jest, afterEach } from "@jest/globals";
import {
  parseArgs,
  drainStream,
  runStream,
  resumeRun,
} from "../scripts/resume.mjs";

describe("parseArgs", () => {
  it("parses namespace, pillar, topic and dry-run", () => {
    expect(
      parseArgs(["ns", "--pillar", "Psychology", "--topic", "T", "--dry-run"]),
    ).toEqual({
      namespace: "ns",
      pillar: "Psychology",
      topic: "T",
      dryRun: true,
      help: false,
    });
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
    const { lastEvent } = await drainStream(sse(completeEvent));
    expect(lastEvent.data.execution.status).toBe("complete");
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

  it("throws when the stream ends with a pending status", async () => {
    await expect(
      drainStream(
        sse({ event: "values", data: { execution: { status: "pending" } } }),
      ),
    ).rejects.toThrow("Run ended prematurely. Final status: pending");
  });

  it("throws when the stream ends with no events", async () => {
    await expect(drainStream(sse())).rejects.toThrow(
      "Run ended prematurely. Final status: unknown",
    );
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

  it("returns on the complete terminal event and cancels the stream even when the server never closes it", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(completeEvent)}\n\n`,
          ),
        );
        // Never closed: simulates a server holding the connection open.
      },
      cancel() {
        cancelled = true;
      },
    });
    const { lastEvent } = await drainStream(
      new Response(stream, { status: 200 }),
    );
    expect(lastEvent.data.execution.status).toBe("complete");
    expect(cancelled).toBe(true);
  });

  it("cancels the stream when the run fails mid-stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ event: "error", data: { error: "boom" } })}\n\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      drainStream(new Response(stream, { status: 200 })),
    ).rejects.toThrow("Graph run failed");
    expect(cancelled).toBe(true);
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
          stream_mode: ["values"],
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
    );
    expect(result).toEqual({
      threadId: "t-new",
      lastEvent: {
        event: "values",
        data: { execution: { status: "complete" } },
      },
    });
  });
});
