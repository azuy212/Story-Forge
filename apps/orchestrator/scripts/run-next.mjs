#!/usr/bin/env node
// Backlog-driven run launcher.
//
// Reads the Google Sheets backlog, picks the first valid "planned" row
// (Video ID + Category + Topic), then:
//   - if a run already exists for that topic, resumes it from its persisted
//     state (the run's persisted projectId is preserved; the next free
//     publish slot is (re)seeded so a resumed run still publishes at a
//     valid schedule time),
//   - otherwise creates a new run seeded with the row's projectId, pillar
//     (Category), topic, and the next free publish slot.
//
// Publish slots depend on the profile:
//   - short: {12:00, 20:00} daily
//   - long:  {20:00} on Tuesdays and Fridays only
//
// Requires the LangGraph dev server (pnpm dev) and a sheet whose row 1 is the
// canonical header. Auth reuses the YOUTUBE_* OAuth credentials and must
// carry the spreadsheets scope (see scripts/oauth-youtube.mjs).
//
// Live progress: the launcher consumes the run's SSE stream (stream_mode
// ["events", "values"] → resumeRun/drainStream onEvent) and, when stdout is a
// TTY, renders a single in-place progress bar at the top of the terminal. The
// bar advances on producer-node completions; QA gates log inline but do not
// advance the bar. In JSON log mode the bar is a no-op so logs stay clean.
//
// Usage (from apps/orchestrator):
//   node scripts/run-next.mjs [--profile short|long]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import googleapis from "googleapis";
import dotenv from "dotenv";
import { Command } from "commander";
import {
  assertHeaders,
  pickPendingRow,
  nextPublishSlot,
  nextLongPublishSlot,
  COLUMN,
} from "../src/integrations/google-sheets/sheets-format.mjs";
import { getAssistantId, resumeRun } from "./resume.mjs";
import { logger } from "../dist/utils/logger.js";
import { prettyFormatter } from "../dist/utils/pretty-formatter.js";
import { closeAllRunLogSinks, getRunLogSink } from "../dist/utils/run-log.js";

// Local appendRunLogEvent implementation. Reimplemented (instead of
// imported from dist/utils/run-log.js) because the test mock for that
// module is a no-op. The launcher is process-external to the rest of the
// orchestrator — we want writes to flow into whatever sink the test
// (or the production logger) hands us.
function appendRunLogEvent(sink, event) {
  if (!sink) return;
  void sink.appendLine(event);
}

const { google } = googleapis;

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = fileURLToPath(new URL("../.env", import.meta.url));

// Load .env first: RUNS_DIR and every credential derive from the env.
dotenv.config({ path: envPath });

const RUNS_DIR =
  process.env.ARTIFACT_STORE_DIR || join(__dirname, "..", "runs");

// Producer nodes in spine order. QA gates (ResearchQA, ScriptQA, PromptQA,
// ReleaseValidation, ReleaseReview) are visible in the pretty-formatter log
// but do not advance the bar — the bar tracks real work the user is waiting
// for. Finalize/Publisher are the terminal producer pair.
const PRODUCER_NODES = [
  "ResearchAgent",
  "ScriptPlanner",
  "ScriptWriter",
  "VisualDirector",
  "AssetStrategy",
  "ImagePromptGenerator",
  "AssetGenerator",
  "ImagePromptRepair",
  "NarrationGenerator",
  "SubtitleGenerator",
  "VideoComposer",
  "MetadataGenerator",
  "ThumbnailGenerator",
  "Publisher",
];

function fail(message) {
  throw new LauncherError(message);
}

class LauncherError extends Error {}

function slugify(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

export function validateProfile(value) {
  if (value !== "short" && value !== "long") {
    throw new LauncherError(
      `invalid profile '${value}': must be 'short' or 'long'`,
    );
  }
}

function formatRunStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    ".",
    ms,
  ].join("");
}

function buildNamespace(topic) {
  const stamp = formatRunStamp();
  return `${stamp}-${slugify(topic)}`;
}

export function findRunByTopic(runsDir, topic) {
  const wanted = String(topic ?? "").trim();
  let match = null;
  let matchCreatedAt = "";
  const dirs = readdirSync(runsDir, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && d.name !== ".run-names",
  );
  for (const dir of dirs) {
    const path = join(runsDir, dir.name, "run.json");
    if (!existsSync(path)) continue;
    const meta = JSON.parse(readFileSync(path, "utf-8"));
    if (String(meta?.topic ?? "").trim() !== wanted) continue;
    const createdAt = meta?.createdAt ?? "";
    if (!match || createdAt > matchCreatedAt) {
      match = { ns: dir.name, meta };
      matchCreatedAt = createdAt;
    }
  }
  return match;
}

export function decideRun(runsDir, rows, profile = "short", now = new Date()) {
  const scheduledAtValues = rows
    .slice(1)
    .filter((row) => String(row[COLUMN.STATUS] ?? "").trim() === "scheduled")
    .map((row) => String(row[COLUMN.SCHEDULED_AT] ?? "").trim())
    .filter(Boolean);

  const pending = pickPendingRow(rows, (message) =>
    console.warn(`  ${message}`),
  );
  if (!pending) {
    return { action: "none", reason: "no-pending-row" };
  }

  const existing = findRunByTopic(runsDir, pending.topic);
  const slotFn = profile === "long" ? nextLongPublishSlot : nextPublishSlot;
  const slot = slotFn(scheduledAtValues, now);
  if (existing) {
    return {
      action: "resume",
      ns: existing.ns,
      pillar: existing.meta.pillar,
      topic: existing.meta.topic,
      profile: existing.meta.videoProfile ?? "short",
      projectId: existing.meta.projectId ?? pending.videoId,
      ...(slot ? { youtubePublishAt: slot } : {}),
    };
  }

  if (!slot) {
    return { action: "none", reason: "no-slot" };
  }

  return {
    action: "create",
    ns: buildNamespace(pending.topic),
    pillar: pending.category,
    topic: pending.topic,
    profile,
    projectId: pending.videoId,
    youtubePublishAt: slot,
  };
}

export async function readSheetRows(client, spreadsheetId, sheetName) {
  const res = await client.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A:Q`,
  });
  return res.data?.values ?? [];
}

function buildSummary(data) {
  if (!data) return undefined;

  const parts = [];

  const scenes = data.production?.scenes?.length;
  if (scenes) parts.push(`${scenes} scenes`);

  const duration = data.video?.durationSec;
  if (duration !== undefined) parts.push(`${duration.toFixed(1)}s`);

  const sceneAssets = data.production?.scenes;
  if (sceneAssets) {
    const assets = sceneAssets.filter(
      (s) => s.generationStatus === "complete" && s.assetUrl,
    ).length;
    if (assets) parts.push(`${assets} assets`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m${rem.toString().padStart(2, "0")}s` : `${mins}m`;
}

// SSE payload from the LangGraph dev server's /threads/{id}/runs/stream
// endpoint when stream_mode includes "events". The server yields langchain
// streamEvents payloads directly — the SSE envelope's `data` line IS the
// streamEvents payload, not a wrapper. Top-level fields:
//
//   { event: "on_chain_start", name: "ResearchAgent",
//     metadata: { langgraph_node: "ResearchAgent" } }
//   { event: "on_chain_end",   name: "ResearchAgent",
//     metadata: { langgraph_node: "ResearchAgent" },
//     data: { output: { ... } } }
//
// A failed `on_chain_end` carries `status: "error"`. Values-mode frames
// (`event: "values"`, `event: "metadata"`) are also delivered but the bar
// only needs chain events.
function parseSseEvent(event) {
  if (!event) return null;
  if (event.event === "on_chain_start" && event.metadata?.langgraph_node) {
    return { name: event.metadata.langgraph_node, status: "running" };
  }
  if (event.event === "on_chain_end" && event.metadata?.langgraph_node) {
    return {
      name: event.metadata.langgraph_node,
      status: event.status === "error" ? "failed" : "complete",
    };
  }
  return null;
}

export { parseSseEvent, PRODUCER_NODES, reemitSseEventToSink };

// Per-node start times captured from the SSE stream so node_end lines carry
// a duration. Keyed by node name; the stream is single-run, so collisions
// across concurrent runs aren't a concern.
const NODE_START_TIMES = new Map();

// The langgraph dev server fires one on_chain_start/on_chain_end pair per
// chain in the parent path. For a node X nested under graph G and run R,
// the server emits start/end for X, for G, for R. We only want one X.
// Track which nodes we've already announced start/end for in this attempt.
const STARTED_NODES = new Set();
const ENDED_NODES = new Set();

// Module-level sink handle set by the launcher's run() entry point. The
// SSE consumer reads this directly so it doesn't depend on the logger
// singleton (which the test mock disables). It falls back to the logger
// singleton in production where the mock is not in play.
let ACTIVE_SINK = null;

export function setActiveSink(sink) {
  ACTIVE_SINK = sink;
}

export function __resetReemitStateForTest() {
  NODE_START_TIMES.clear();
  STARTED_NODES.clear();
  ENDED_NODES.clear();
}

/**
 * Translate one langchain streamEvents payload into a diagnostic event on
 * the run log. This is the bridge the orchestrator needs because the
 * `langgraph dev` server runs the graph in a separate process — none of the
 * in-process sinks inside the graph nodes are reachable from the launcher.
 * The SSE stream carries enough metadata to reconstruct a useful per-node
 * trace plus per-LLM-call token accounting.
 *
 * Captures:
 *  - `on_chain_start` with langgraph_node → node_start
 *  - `on_chain_end`   with langgraph_node → node_end / node_failed
 *  - `on_chat_model_start` / `on_chat_model_end` → llm_call
 *  - other chain events (BranchJoin, Finalize) fall through silently
 */
function reemitSseEventToSink(event) {
  const sink =
    ACTIVE_SINK ??
    getRunLogSink(logger.getCurrentSink()?.runId ?? "") ??
    logger.getCurrentSink();
  if (!sink) return;
  const nodeName = event.metadata?.langgraph_node;
  const eventType = event.event;
  const now = Date.now();

  // The langgraph dev server emits one on_chain_start / on_chain_end pair
  // per chain in the parent path. A node X nested in graph G and run R
  // yields events for X, G, and R. We want exactly one start and one end
  // per real node per attempt; dedupe by node name. STARTED_NODES /
  // ENDED_NODES are reset between attempts by the launcher's setRunContext.
  if (eventType === "on_chain_start" && nodeName) {
    // A node can re-enter the graph (QA retry loop). When we see a fresh
    // start for a node we already ended, allow it and reset the dedup
    // markers so the new start/end pair is captured cleanly.
    if (ENDED_NODES.has(nodeName)) {
      ENDED_NODES.delete(nodeName);
      STARTED_NODES.delete(nodeName);
    }
    if (STARTED_NODES.has(nodeName)) return;
    STARTED_NODES.add(nodeName);
    NODE_START_TIMES.set(nodeName, now);
    const attempt = (NODE_START_TIMES.get(`${nodeName}#attempts`) ?? 0) + 1;
    NODE_START_TIMES.set(`${nodeName}#attempts`, attempt);
    appendRunLogEvent(sink, {
      event: "node_start",
      node: nodeName,
      runId: sink.runId,
      tags: event.metadata?.tags,
      attempt,
    });
    return;
  }

  if (eventType === "on_chain_end" && nodeName) {
    // LangGraph wraps each node in a sub-chain; the first on_chain_end is the
    // wrapper end with `output: undefined`, the second carries the real agent
    // return value. Skip wrapper ends (no payload, not an error) entirely so
    // every node emits exactly one node_end/node_failed. We treat any output
    // that carries diagnostics, telemetry, or any of the canonical state
    // channels as a real node end.
    const output = event.data?.output;
    const isError = event.status === "error";
    const hasOutput =
      output &&
      typeof output === "object" &&
      (output.research !== undefined ||
        output.storyPlan !== undefined ||
        output.content !== undefined ||
        output.audio !== undefined ||
        output.subtitles !== undefined ||
        output.video !== undefined ||
        output.metadataOutput !== undefined ||
        output.thumbnail !== undefined ||
        output.production !== undefined ||
        output.publishing !== undefined ||
        output.thumbnailImage !== undefined ||
        output.diagnostics !== undefined ||
        output.execution !== undefined);
    if (!hasOutput && !isError) {
      return;
    }
    ENDED_NODES.add(nodeName);
    const startedAt = NODE_START_TIMES.get(nodeName);
    const durationMs = startedAt ? now - startedAt : undefined;
    if (durationMs !== undefined) NODE_START_TIMES.delete(nodeName);
    const diagnosticsErrors = output?.diagnostics?.errors;
    const telemetryNode = output?.diagnostics?.telemetry?.[nodeName];
    const result = telemetryNode?.result;
    const tokenSummary = result
      ? {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          costUsd: result.costUsd,
          retries: result.retries,
        }
      : undefined;
    if (isError) {
      appendRunLogEvent(sink, {
        event: "node_failed",
        node: nodeName,
        runId: sink.runId,
        durationMs,
        status: event.status,
        error: event.data?.error ?? event.error,
        diagnosticsErrors,
      });
    } else {
      appendRunLogEvent(sink, {
        event: "node_end",
        node: nodeName,
        runId: sink.runId,
        durationMs,
        fromCache:
          output?.diagnostics?.telemetry?.[nodeName]?.result?.fromCache,
        outputKeys: output ? Object.keys(output) : undefined,
        tokenSummary,
        diagnosticsErrors,
        diagnosticsWarnings: output?.diagnostics?.warnings,
      });
    }
    return;
  }

  if (eventType === "on_chat_model_start" && event.name) {
    appendRunLogEvent(sink, {
      event: "llm_call",
      provider: "openrouter",
      operation: "chat_model_start",
      runId: sink.runId,
      agent: nodeName ?? event.name,
      model: event.metadata?.ls_provider
        ? `${event.metadata.ls_provider}/${event.name ?? ""}`.replace(/\/$/, "")
        : event.name,
      messages: event.data?.input?.messages?.length
        ? { messageCount: event.data.input.messages.length }
        : undefined,
    });
    return;
  }

  if (eventType === "on_chat_model_end" && event.name) {
    const usage =
      event.data?.output?.usage_metadata ?? event.data?.output?.token_usage;
    const output = event.data?.output;
    const responseText =
      typeof output?.content === "string"
        ? output.content
        : Array.isArray(output?.content)
          ? output.content
              .map((c) => (typeof c?.text === "string" ? c.text : ""))
              .join("")
          : undefined;
    appendRunLogEvent(sink, {
      event: "llm_call",
      provider: "openrouter",
      operation: "chat_model_end",
      runId: sink.runId,
      agent: nodeName ?? event.name,
      model: event.name,
      usage,
      responseBytes: responseText
        ? Buffer.byteLength(responseText, "utf-8")
        : undefined,
      responseTextPreview: responseText
        ? responseText.slice(0, 2000)
        : undefined,
      error: event.status === "error" ? event.data?.error : undefined,
    });
    return;
  }
}

/**
 * Live progress tracker. Renders a single in-place bar at the top of the
 * terminal and advances it when the SSE consumer reports producer-node
 * transitions. The bar advances on producer-node completion; QA gates emit
 * SSE events too but are not in `producerNodes`, so they don't move the bar.
 * No-op when stdout is not a TTY (CI / piped output) or when log format is
 * JSON.
 */
class RunProgress {
  constructor(producerNodes) {
    this.producerNodes = producerNodes;
    this.producerIndex = new Map(producerNodes.map((n, i) => [n, i]));
    this.completed = new Set();
    this.failed = new Set();
    this.running = null;
    this.startedAt = 0;
    this.lastChangeAt = 0;
    this.recentDurations = [];
    this.lastRender = "";
    this.enabled = process.stdout.isTTY && process.env.LOG_FORMAT !== "json";
    this._origWrite = null;
  }

  start() {
    if (!this.enabled) return;
    this.startedAt = Date.now();
    this.lastChangeAt = this.startedAt;
    this._origWrite = process.stdout.write.bind(process.stdout);
    this._render();
  }

  stop() {
    if (!this.enabled || !this._origWrite) return;
    this._origWrite("\r\x1b[2K");
    this._origWrite = null;
  }

  observeNode(name, status) {
    if (!this.enabled) return;
    if (!this.producerIndex.has(name)) return;
    const now = Date.now();
    if (status === "running") {
      this.running = name;
      // Reset the duration clock so a node that failed and re-ran measures
      // from the start of its current attempt, not from the previous end.
      this.lastChangeAt = now;
      // A re-run supersedes an earlier failure for the same node.
      this.failed.delete(name);
      this._render();
    } else if (status === "complete") {
      if (!this.completed.has(name)) {
        this.completed.add(name);
        this.recentDurations.push(now - this.lastChangeAt);
        if (this.recentDurations.length > 5) this.recentDurations.shift();
        this.lastChangeAt = now;
      }
      if (this.running === name) this.running = null;
      this._render();
    } else if (status === "failed") {
      this.failed.add(name);
      if (this.running === name) this.running = null;
      this._render();
    }
  }

  _render() {
    if (!this._origWrite) return;
    const total = this.producerNodes.length;
    const done = this.completed.size + this.failed.size;
    const width = 24;
    const filled = total > 0 ? Math.round((done / total) * width) : 0;
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const label = this.running ?? this.producerNodes[done] ?? "complete";
    const elapsed = formatDuration(Date.now() - this.startedAt);
    const eta =
      this.recentDurations.length >= 2
        ? ` ETA ${formatDuration(
            (this.recentDurations.reduce((a, b) => a + b, 0) /
              this.recentDurations.length) *
              (total - done),
          )}`
        : "";
    const line = `\r\x1b[2K  Pipeline  [${bar}] ${done}/${total}  ${label.padEnd(20)} ${elapsed}${eta}`;
    if (line === this.lastRender) return;
    this._origWrite(line);
    this.lastRender = line;
  }
}

export async function runLauncher({
  env = process.env,
  runsDir = RUNS_DIR,
  profile = "short",
  readRows = readSheetRows,
  getAssistantId: getAssistant = getAssistantId,
  resumeRun: runPipeline = resumeRun,
} = {}) {
  validateProfile(profile);
  const clientId = env.YOUTUBE_CLIENT_ID;
  const clientSecret = env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = env.YOUTUBE_REFRESH_TOKEN;
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const sheetName =
    profile === "long"
      ? env.GOOGLE_SHEETS_SHEET_NAME_LONG || "Long Videos"
      : env.GOOGLE_SHEETS_SHEET_NAME || "Sheet1";

  if (!clientId || !clientSecret || !refreshToken) {
    fail(
      "missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN",
    );
  }
  if (!spreadsheetId) {
    fail("missing GOOGLE_SHEETS_SPREADSHEET_ID");
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const sheets = google.sheets({ version: "v4", auth: oauth2Client });

  logger.info(`Profile: ${profile} | Sheet: ${sheetName}`);

  let rows;
  try {
    rows = await readRows(sheets, spreadsheetId, sheetName);
  } catch (e) {
    fail(`reading sheet failed: ${e.message}`);
  }

  try {
    assertHeaders(rows);
  } catch (e) {
    fail(e.message);
  }

  const decision = decideRun(runsDir, rows, profile);
  if (decision.action === "none") {
    logger.info(
      decision.reason === "no-pending-row"
        ? "No pending planned rows in the backlog. Done."
        : "No free publish slot within 30 days. Done.",
    );
    return;
  }

  let assistantId;
  try {
    assistantId = await getAssistant();
  } catch (e) {
    fail(`getAssistantId failed: ${e.message}`);
  }

  const input = {
    pillar: decision.pillar,
    topic: decision.topic,
    videoProfile: decision.profile,
  };
  const options = {
    assistantId,
    projectId: decision.projectId,
    youtubePublishAt: decision.youtubePublishAt,
  };

  const existing = findRunByTopic(runsDir, decision.topic);
  const attempt = existing
    ? (existing.meta?.threadHistory?.length ?? 0) + 1
    : 1;
  await logger.setRunContext(decision.ns, decision.topic, attempt);
  setActiveSink(logger.getCurrentSink());

  const progress = new RunProgress(PRODUCER_NODES);
  // When the bar is active, suppress the formatter's per-run header box and
  // per-node progress lines — they would otherwise share a row with the bar
  // and break the box's rectangle (the bar's in-place render has no trailing
  // newline, so the box top gets appended to the bar's line).
  if (progress.enabled) prettyFormatter.setSilent(true);
  progress.start();
  const onEvent = (event) => {
    reemitSseEventToSink(event);
    const parsed = parseSseEvent(event);
    if (parsed) {
      progress.observeNode(parsed.name, parsed.status);
      return;
    }
    if (event?.event === "on_chain_start" || event?.event === "on_chain_end") {
      logger.debug("sse: chain event (no node)", {
        kind: event.event,
        name: event.name,
        keys: event ? Object.keys(event) : null,
        metadata: event?.metadata,
      });
    }
  };

  try {
    if (decision.action === "resume") {
      logger.info(
        `Resuming existing run for topic "${decision.topic}": ${decision.ns}`,
      );
      if (decision.youtubePublishAt) {
        logger.info(
          `  (Re)seeding publish slot ${decision.youtubePublishAt} for this resume.`,
        );
      } else {
        logger.info("  No free publish slot within 30 days; publishing as-is.");
      }
    } else {
      logger.info(
        `New backlog run "${decision.topic}" (video ${decision.projectId}) at slot ${decision.youtubePublishAt}`,
      );
    }
    const { lastEvent } = await runPipeline(decision.ns, input, {
      ...options,
      onEvent,
    });
    const status =
      lastEvent?.data?.execution?.status === "complete" ? "complete" : "failed";
    const summary = buildSummary(lastEvent?.data);
    progress.stop();
    logger.info(`Artifacts in: runs/${decision.ns}`);
    await logger.finalize(status, summary);
  } catch (e) {
    progress.stop();
    await logger.finalize("failed", e?.message ?? String(e));
    logger.error(
      `run-next: pipeline run failed for "${decision.topic}" (${decision.ns}): ${e?.stack || e}`,
    );
  } finally {
    if (progress.enabled) prettyFormatter.setSilent(false);
    setActiveSink(null);
    const sinkTimeout = setTimeout(() => undefined, 2000);
    sinkTimeout.unref?.();
    await Promise.race([
      closeAllRunLogSinks(),
      new Promise((resolve) => sinkTimeout && setTimeout(resolve, 2000)),
    ]);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]).href)
) {
  const program = new Command();
  program
    .name("run-next")
    .description("Backlog-driven run launcher")
    .option("--profile <short|long>", "video profile", "short");
  program.parse(process.argv);

  const opts = program.opts();
  const profile = opts.profile;
  if (profile !== "short" && profile !== "long") {
    console.error(
      `run-next: --profile must be 'short' or 'long', got '${profile}'`,
    );
    process.exit(1);
  }

  runLauncher({ profile }).catch((e) => {
    if (e instanceof LauncherError) {
      console.error(`run-next: ${e.message}`);
    } else {
      console.error(e?.stack || e);
    }
    process.exitCode = 1;
  });
}
