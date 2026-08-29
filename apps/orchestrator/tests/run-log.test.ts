import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openRunLogSink,
  getRunLogSink,
  getRunLogSinkFromConfig,
  closeRunLogSink,
  closeAllRunLogSinks,
  appendRunLogEvent,
  withProviderLog,
  sanitizeHeaders,
  resetRunLogSinks,
} from "../src/utils/run-log.js";

describe("openRunLogSink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-log-test-"));
    process.env.ARTIFACT_STORE_DIR = dir;
    delete process.env.ORCHESTRATOR_LOG_FILE;
    delete process.env.ORCHESTRATOR_LOG_MAX_LINE_BYTES;
    delete process.env.ORCHESTRATOR_LOG_MESSAGES;
    jest.resetModules();
    resetRunLogSinks();
  });

  afterEach(() => {
    closeAllRunLogSinks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a run_start line on first open", async () => {
    const sink = await openRunLogSink({
      runId: "run-1",
      topic: "Test Topic",
      attempt: 1,
      runDir: `${dir}/run-1`,
      env: {},
    });
    expect(sink).not.toBeNull();
    await sink?.flush();

    const content = readFileSync(join(dir, "run-1", "run.log"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe("run_start");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.topic).toBe("Test Topic");
    expect(parsed.attempt).toBe(1);
    expect(parsed.env).toBeDefined();
  });

  it("returns the same sink for repeat calls on the same runId", async () => {
    const a = await openRunLogSink({
      runId: "run-2",
      topic: "Repeat",
      attempt: 1,
      runDir: `${dir}/run-2`,
      env: {},
    });
    const b = await openRunLogSink({
      runId: "run-2",
      topic: "Repeat",
      attempt: 1,
      runDir: `${dir}/run-2`,
      env: {},
    });
    expect(a).toBe(b);
  });

  it("appends one line per appendLine call", async () => {
    const sink = await openRunLogSink({
      runId: "run-3",
      topic: "Multi",
      attempt: 1,
      runDir: `${dir}/run-3`,
      env: {},
    });
    appendRunLogEvent(sink, { event: "node_start", node: "A" });
    appendRunLogEvent(sink, { event: "node_start", node: "B" });
    appendRunLogEvent(sink, { event: "node_failed", node: "B", reason: "x" });
    await sink?.flush();

    const lines = readFileSync(join(dir, "run-3", "run.log"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(4); // run_start + 3 events
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toEqual([
      "run_start",
      "node_start",
      "node_start",
      "node_failed",
    ]);
  });

  it("serializes concurrent appends without tearing lines", async () => {
    const sink = await openRunLogSink({
      runId: "run-4",
      topic: "Concurrent",
      attempt: 1,
      runDir: `${dir}/run-4`,
      env: {},
    });
    const writers = Array.from({ length: 50 }, (_, i) =>
      appendRunLogEvent(sink, {
        event: "log_message",
        level: "info",
        message: `m-${i}`,
      }),
    );
    await Promise.all(writers);
    await sink?.flush();

    const content = readFileSync(join(dir, "run-4", "run.log"), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.runId).toBe("run-4");
    }
    expect(lines.length).toBe(51); // run_start + 50 messages
  });

  it("appends to an existing file when the runId already has data on disk", async () => {
    const runDir = join(dir, "run-5");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.log"), ""); // simulate prior writes
    const sink = await openRunLogSink({
      runId: "run-5",
      topic: "Append",
      attempt: 1,
      runDir,
      env: {},
    });
    appendRunLogEvent(sink, { event: "node_start", node: "A" });
    await sink?.flush();
    const content = readFileSync(join(runDir, "run.log"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("never throws when given a bad event", async () => {
    const sink = await openRunLogSink({
      runId: "run-6",
      topic: "Bad",
      attempt: 1,
      runDir: `${dir}/run-6`,
      env: {},
    });
    // Force a circular structure to make JSON.stringify throw.
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(() =>
      appendRunLogEvent(sink, { event: "log_message", payload: circ }),
    ).not.toThrow();
    await sink?.flush();
  });

  it("close() prevents further writes", async () => {
    const sink = await openRunLogSink({
      runId: "run-7",
      topic: "Close",
      attempt: 1,
      runDir: `${dir}/run-7`,
      env: {},
    });
    await sink?.close();
    await sink?.appendLine({
      ts: new Date().toISOString(),
      runId: "run-7",
      event: "node_start",
    });
    const exists = existsSync(join(dir, "run-7", "run.log"));
    expect(exists).toBe(true);
  });
});

describe("getRunLogSink / getRunLogSinkFromConfig", () => {
  it("returns null when no sink is registered for the runId", () => {
    expect(getRunLogSink("nope")).toBeNull();
  });

  it("returns the registered sink for the runId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-log-get-"));
    process.env.ARTIFACT_STORE_DIR = dir;
    jest.resetModules();
    resetRunLogSinks();
    const sink = await openRunLogSink({
      runId: "get-1",
      topic: "Lookup",
      attempt: 1,
      runDir: `${dir}/get-1`,
      env: {},
    });
    expect(getRunLogSink("get-1")).toBe(sink);
    closeAllRunLogSinks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the sink from RunnableConfig.configurable.runLogSink", () => {
    const fakeSink = { appendLine: jest.fn() } as unknown as {
      appendLine: () => Promise<void>;
    };
    const cfg = {
      configurable: { runLogSink: fakeSink },
    } as unknown as Parameters<typeof getRunLogSinkFromConfig>[0];
    expect(getRunLogSinkFromConfig(cfg)).toBe(fakeSink);
  });

  it("returns null when configurable has no runLogSink", () => {
    const cfg = { configurable: {} } as unknown as Parameters<
      typeof getRunLogSinkFromConfig
    >[0];
    expect(getRunLogSinkFromConfig(cfg)).toBeNull();
  });
});

describe("closeRunLogSink / closeAllRunLogSinks", () => {
  it("closeRunLogSink is a no-op for unknown runIds", async () => {
    await expect(closeRunLogSink("does-not-exist")).resolves.toBeUndefined();
  });

  it("closeAllRunLogSinks clears the registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-log-close-"));
    process.env.ARTIFACT_STORE_DIR = dir;
    jest.resetModules();
    resetRunLogSinks();
    await openRunLogSink({
      runId: "close-1",
      topic: "Clear",
      attempt: 1,
      runDir: `${dir}/close-1`,
      env: {},
    });
    expect(getRunLogSink("close-1")).not.toBeNull();
    await closeAllRunLogSinks();
    expect(getRunLogSink("close-1")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("withProviderLog", () => {
  it("returns the inner result on success and populates timing + error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-log-prov-"));
    process.env.ARTIFACT_STORE_DIR = dir;
    jest.resetModules();
    resetRunLogSinks();
    const sink = await openRunLogSink({
      runId: "prov-1",
      topic: "Provider",
      attempt: 1,
      runDir: `${dir}/prov-1`,
      env: {},
    });
    const result = await withProviderLog(
      sink,
      { event: "provider_call", provider: "test", operation: "noop" },
      async () => 42,
    );
    expect(result).toBe(42);
    await sink?.flush();
    const lines = readFileSync(join(dir, "prov-1", "run.log"), "utf-8")
      .trim()
      .split("\n");
    const providerLine = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "provider_call");
    expect(providerLine).toBeDefined();
    expect(providerLine.requestDurationMs).toBeGreaterThanOrEqual(0);
    expect(providerLine.error).toBeUndefined();
    closeAllRunLogSinks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rethrows and logs error on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-log-prov-"));
    process.env.ARTIFACT_STORE_DIR = dir;
    jest.resetModules();
    resetRunLogSinks();
    const sink = await openRunLogSink({
      runId: "prov-2",
      topic: "Provider Err",
      attempt: 1,
      runDir: `${dir}/prov-2`,
      env: {},
    });
    await expect(
      withProviderLog(
        sink,
        { event: "provider_call", provider: "test", operation: "boom" },
        async () => {
          throw new Error("nope");
        },
      ),
    ).rejects.toThrow("nope");
    await sink?.flush();
    const lines = readFileSync(join(dir, "prov-2", "run.log"), "utf-8")
      .trim()
      .split("\n");
    const providerLine = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "provider_call");
    expect(providerLine).toBeDefined();
    expect(providerLine.error.message).toBe("nope");
    expect(providerLine.error.name).toBe("Error");
    closeAllRunLogSinks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the result untouched when sink is null", async () => {
    const result = await withProviderLog(
      null,
      { event: "provider_call", provider: "x", operation: "y" },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });
});

describe("sanitizeHeaders", () => {
  it("redacts sensitive header names case-insensitively", () => {
    const out = sanitizeHeaders({
      Authorization: "Bearer secret",
      "X-API-Key": "abc",
      cookie: "session=1",
      "Content-Type": "application/json",
    });
    expect(out.Authorization).toBe("***");
    expect(out["X-API-Key"]).toBe("***");
    expect(out.cookie).toBe("***");
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("returns an empty object for missing input", () => {
    expect(sanitizeHeaders(undefined)).toEqual({});
  });
});
