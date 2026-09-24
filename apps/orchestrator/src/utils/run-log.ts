import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import { config as appConfig } from "./config.js";
import { getRunsDir } from "../artifacts/namespace.js";

/**
 * Per-run append-only NDJSON diagnostic log.
 *
 * `runs/<ns>/run.log` is the single source of truth for everything that
 * happened during a run: graph routing, QA decisions, per-scene fan-out, LLM
 * I/O, third-party provider I/O, internal provider I/O, FFmpeg, and final
 * state. One file per run, one line per event. Lines are appended
 * lock-serialized via a directory lock (same shape as `run-meta.mjs`) so
 * parallel nodes do not interleave partial lines.
 *
 * The sink is best-effort: any failure (file system error, oversize line,
 * serialization error) is swallowed and never propagates to the caller. The
 * run's primary path must never depend on log writes succeeding.
 */

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;
const TRUNCATION_MARKER = "\u2026 [truncated %d bytes]";

export interface RunLogContext {
  runId: string;
  topic: string;
  attempt: number;
  threadId?: string;
  profile?: string;
  projectId?: string;
  pillar?: string;
  runDir: string;
  env: Record<string, string | number | boolean | undefined>;
}

export type RunLogEventType =
  | "run_start"
  | "node_start"
  | "node_end"
  | "node_failed"
  | "node_retry"
  | "node_skipped"
  | "node_incomplete"
  | "qa_decision"
  | "classifier"
  | "router"
  | "scene_event"
  | "llm_call"
  | "provider_call"
  | "asset_written"
  | "log_message"
  | "run_final";

export interface RunLogEvent {
  ts: string;
  runId: string;
  event: RunLogEventType;
  [key: string]: unknown;
}

export type RunLogEventInput =
  | RunLogEvent
  | (Omit<Partial<RunLogEvent>, "ts" | "runId"> & {
      event: RunLogEventType;
      [key: string]: unknown;
    });

export interface RunLogSink {
  readonly runId: string;
  readonly filePath: string;
  appendLine(event: RunLogEventInput): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const sinks = new Map<string, RunLogSink>();
let exitHandlersRegistered = false;
let exitHandler: (() => void) | null = null;

function safeJsonStringify(value: unknown, maxBytes: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      _serializationError: (err as Error)?.message ?? String(err),
    });
  }
  const byteLength = Buffer.byteLength(serialized, "utf-8");
  if (byteLength <= maxBytes) return serialized;
  const truncated: Record<string, unknown> = {
    _truncated: true,
    _originalBytes: byteLength,
    _maxBytes: maxBytes,
  };
  return JSON.stringify(truncated);
}

function truncateBody(body: unknown, maxBytes: number): unknown {
  if (body === undefined || body === null) return body;
  if (typeof body === "string") {
    const bytes = Buffer.byteLength(body, "utf-8");
    if (bytes <= maxBytes) return body;
    const half = Math.floor(maxBytes / 2);
    return (
      body.slice(0, half) +
      TRUNCATION_MARKER.replace("%d", String(bytes - 2 * half)) +
      body.slice(body.length - half)
    );
  }
  return body;
}

async function acquireLock(filePath: string): Promise<() => Promise<void>> {
  const lockDir = `${filePath}.lock`;
  const ownerPath = join(lockDir, "owner.json");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        ownerPath,
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        "utf-8",
      );
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const stale = await isLockStale(lockDir);
      if (stale && (await reclaimStaleLock(lockDir))) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockDir}`, {
          cause: err,
        });
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  return async () => {
    try {
      await rm(lockDir, { recursive: true, force: true });
    } catch {
      // already released
    }
  };
}

async function isLockStale(lockDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(lockDir, "owner.json"), "utf-8");
    const owner = JSON.parse(raw) as {
      pid?: number;
      createdAt?: number;
    };
    if (owner.pid && !pidAlive(owner.pid)) return true;
    if (owner.createdAt && Date.now() - owner.createdAt > LOCK_STALE_MS) {
      return true;
    }
    return false;
  } catch {
    try {
      const s = await stat(lockDir);
      return Date.now() - s.mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function reclaimStaleLock(lockDir: string): Promise<boolean> {
  const quarantine = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(lockDir, quarantine);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    await rm(quarantine, { recursive: true, force: true });
  } catch {
    // best effort
  }
  return true;
}

class FsRunLogSink implements RunLogSink {
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    public readonly runId: string,
    public readonly filePath: string,
  ) {}

  appendLine(event: RunLogEventInput): Promise<void> {
    if (this.closed) return Promise.resolve();
    const ts = (event as RunLogEvent).ts ?? new Date().toISOString();
    const enriched: RunLogEvent = {
      ...(event as object),
      ts,
      runId: this.runId,
    } as RunLogEvent;
    const maxBytes = appConfig.runLogMaxLineBytes();
    const line = safeJsonStringify(enriched, maxBytes);
    this.writeQueue = this.writeQueue.then(() => this.doWrite(line));
    return this.writeQueue.catch(() => undefined);
  }

  private async doWrite(line: string): Promise<void> {
    if (this.closed) return;
    const release = await acquireLock(this.filePath);
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${line}\n`, "utf-8");
    } finally {
      await release();
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeQueue.catch(() => undefined);
  }
}

/**
 * Returns the active sink for `runId`, opening it on first call. Reopens an
 * existing file in append mode so retries that survive a process boundary
 * continue writing to the same log.
 *
 * Returns `null` when the file log is disabled via `ORCHESTRATOR_LOG_FILE`
 * or when the file cannot be opened; never throws.
 */
export async function openRunLogSink(
  context: RunLogContext,
): Promise<RunLogSink | null> {
  if (!appConfig.runLogFileEnabled()) return null;
  const existing = sinks.get(context.runId);
  if (existing) return existing;
  const filePath = join(getRunsDir(), context.runId, "run.log");
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch {
    return null;
  }
  const sink = new FsRunLogSink(context.runId, filePath);
  sinks.set(context.runId, sink);
  registerProcessExitHandlers();
  const envSummary: Record<string, string | number | boolean | undefined> = {
    LOG_LEVEL: process.env.LOG_LEVEL,
    LOG_FORMAT: process.env.LOG_FORMAT,
    DEFAULT_MODEL: process.env.DEFAULT_MODEL,
    USE_REAL_PROVIDERS: process.env.USE_REAL_PROVIDERS,
    ARTIFACT_STORE_ENABLED: process.env.ARTIFACT_STORE_ENABLED,
    ORCHESTRATOR_LOG_FILE: process.env.ORCHESTRATOR_LOG_FILE,
    ORCHESTRATOR_LOG_MESSAGES: process.env.ORCHESTRATOR_LOG_MESSAGES,
    IMAGE_PROVIDER_URL: process.env.IMAGE_PROVIDER_URL,
    TTS_URL: process.env.TTS_URL,
    TTS_PROVIDER: process.env.TTS_PROVIDER,
    OPENROUTER_TTS_MODEL: process.env.OPENROUTER_TTS_MODEL,
    OPENROUTER_TTS_VOICE: process.env.OPENROUTER_TTS_VOICE,
    OPENROUTER_TTS_RESPONSE_FORMAT: process.env.OPENROUTER_TTS_RESPONSE_FORMAT,
    NARRATION_GENERATION_MODE: process.env.NARRATION_GENERATION_MODE,
    TRANSCRIBER_URL: process.env.TRANSCRIBER_URL,
    NODE_ENV: process.env.NODE_ENV,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
  };
  await sink.appendLine({
    runId: context.runId,
    event: "run_start",
    topic: context.topic,
    attempt: context.attempt,
    threadId: context.threadId,
    profile: context.profile,
    projectId: context.projectId,
    pillar: context.pillar,
    runDir: context.runDir,
    env: envSummary,
  } as RunLogEventInput);
  return sink;
}

export function getRunLogSink(runId: string): RunLogSink | null {
  return sinks.get(runId) ?? null;
}

export function getRunLogSinkFromConfig(
  config: RunnableConfig | undefined,
): RunLogSink | null {
  const inject = (config?.configurable ?? {}) as Record<string, unknown>;
  const sink = inject.runLogSink;
  if (sink && typeof sink === "object" && "appendLine" in sink) {
    return sink as RunLogSink;
  }
  return null;
}

export function getRunLogContextFromConfig(
  config: RunnableConfig | undefined,
): { runId?: string; topic?: string; attempt?: number } {
  const inject = (config?.configurable ?? {}) as Record<string, unknown>;
  return {
    runId:
      typeof inject.runId === "string" ? (inject.runId as string) : undefined,
    topic:
      typeof inject.topic === "string" ? (inject.topic as string) : undefined,
    attempt:
      typeof inject.attempt === "number"
        ? (inject.attempt as number)
        : undefined,
  };
}

export async function closeRunLogSink(runId: string): Promise<void> {
  const sink = sinks.get(runId);
  if (!sink) return;
  sinks.delete(runId);
  await sink.close();
}

export async function closeAllRunLogSinks(): Promise<void> {
  const all = [...sinks.values()];
  sinks.clear();
  await Promise.all(all.map((s) => s.close()));
  unregisterProcessExitHandlers();
}

export function resetRunLogSinks(): void {
  sinks.clear();
}

/**
 * Best-effort append. Returns immediately when the sink is missing or the
 * event fails to serialize. Never throws to the caller — the run's primary
 * path must not depend on log writes.
 */
export function appendRunLogEvent(
  sink: RunLogSink | null | undefined,
  event: RunLogEventInput | Record<string, unknown>,
): void {
  if (!sink) return;
  void sink.appendLine(event as RunLogEventInput);
}

/**
 * Convenience wrapper for provider I/O. Populates `requestDurationMs`,
 * `responseStatus`, `responseHeaders` (sanitized), `responseBody` (truncated
 * per `ORCHESTRATOR_LOG_MAX_LINE_BYTES`), `error?` on throw.
 */
export async function withProviderLog<T>(
  sink: RunLogSink | null | undefined,
  event: RunLogEventInput | Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sink) return fn();
  const startedAt = Date.now();
  const mutable = event as Record<string, unknown>;
  try {
    const result = await fn();
    mutable.requestDurationMs = Date.now() - startedAt;
    mutable.error = undefined;
    appendRunLogEvent(sink, mutable);
    return result;
  } catch (err) {
    mutable.requestDurationMs = Date.now() - startedAt;
    mutable.error = {
      message: (err as Error)?.message ?? String(err),
      name: (err as Error)?.name,
      code: (err as { code?: unknown })?.code,
    };
    appendRunLogEvent(sink, mutable);
    throw err;
  }
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
  "x-goog-api-key",
]);

export function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      out[name] = "***";
    } else {
      out[name] = value;
    }
  }
  return out;
}

export function truncateLogBody(body: unknown, maxBytes?: number): unknown {
  const cap = maxBytes ?? appConfig.runLogMaxLineBytes();
  return truncateBody(body, cap);
}

function registerProcessExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  const handler = (): void => {
    // Synchronous best-effort: awaiting close here would block the event
    // loop and miss the exit. The sink's write queue is microtask-batched
    // so any in-flight line lands before the process actually exits.
    void closeAllRunLogSinks();
  };
  exitHandler = handler;
  process.on("beforeExit", handler);
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

function unregisterProcessExitHandlers(): void {
  if (!exitHandlersRegistered || !exitHandler) return;
  process.off("beforeExit", exitHandler);
  process.off("SIGTERM", exitHandler);
  process.off("SIGINT", exitHandler);
  exitHandler = null;
  exitHandlersRegistered = false;
}
