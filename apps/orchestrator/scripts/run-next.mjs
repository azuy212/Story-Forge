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
// Live progress: the launcher installs a console.log tap that observes the
// pretty-formatter's per-node lines (▶ running, ✓ complete, ✗ failed, ↻ retry)
// and updates a single in-place progress bar at the top of the terminal. The
// bar advances on producer-node completions; QA gates log inline but do not
// advance the bar. In JSON log mode the tap is a no-op so logs stay clean.
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
import { logger } from "../dist/src/utils/logger.js";

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
  "StoryPlanner",
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

// Pretty-formatter node line shape: "  ICON LABEL(24p)PHASE(36p)DURATION(10p)".
// Label is left-padded to 24 chars; strip trailing spaces and use the
// remainder as the node name. Icons: ▶ running, ✓ complete, ✗ failed, ↻ retry.
const NODE_LINE_RE = /^[ \t]*([▶✓✗↻])[ \t]+(\S.{0,30}?)(?:[ \t]{2,}|$)/;

function parseNodeLine(line) {
  const m = NODE_LINE_RE.exec(line);
  if (!m) return null;
  return { icon: m[1], label: m[2].trim() };
}

export { parseNodeLine, PRODUCER_NODES, NODE_LINE_RE };

/**
 * Live progress tracker. Renders a single in-place bar at the top of the
 * terminal and observes pretty-formatter output (via a console.log tap) to
 * advance the bar. The bar advances on producer-node completion; QA gates
 * fire pretty lines but do not move the bar. No-op when stdout is not a TTY
 * (CI / piped output) or when log format is JSON.
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
    // Clear the bar line so the next pretty output starts cleanly.
    this._origWrite("\r\x1b[2K");
    this._origWrite = null;
  }

  observe(line) {
    if (!this.enabled) return;
    const parsed = parseNodeLine(line);
    if (!parsed) return;
    const idx = this.producerIndex.get(parsed.label);
    if (idx === undefined) return;
    const now = Date.now();
    if (parsed.icon === "▶") {
      this.running = parsed.label;
      this._render();
    } else if (parsed.icon === "✓") {
      if (!this.completed.has(parsed.label)) {
        this.completed.add(parsed.label);
        this.recentDurations.push(now - this.lastChangeAt);
        if (this.recentDurations.length > 5) this.recentDurations.shift();
        this.lastChangeAt = now;
      }
      if (this.running === parsed.label) this.running = null;
      this._render();
    } else if (parsed.icon === "✗") {
      this.failed.add(parsed.label);
      if (this.running === parsed.label) this.running = null;
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

/**
 * Install a console.log tap that pipes every line through `onLine` and
 * forwards to the real `console.log`. Used to observe pretty-formatter
 * output. Returns a teardown function.
 */
function tapConsoleLog(onLine) {
  const orig = console.log;
  console.log = (...args) => {
    const line = args
      .map((a) => (typeof a === "string" ? a : String(a)))
      .join(" ");
    onLine(line);
    orig.apply(console, args);
  };
  return () => {
    console.log = orig;
  };
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
  logger.setRunContext(decision.ns, decision.topic, attempt);

  const progress = new RunProgress(PRODUCER_NODES);
  const teardownTap = tapConsoleLog((line) => progress.observe(line));
  progress.start();

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
    const { lastEvent } = await runPipeline(decision.ns, input, options);
    const status =
      lastEvent?.data?.execution?.status === "complete" ? "complete" : "failed";
    const summary = buildSummary(lastEvent?.data);
    progress.stop();
    teardownTap();
    logger.finalize(status, summary);
    logger.info(`Artifacts in: runs/${decision.ns}`);
  } catch (e) {
    progress.stop();
    teardownTap();
    logger.finalize("failed", e?.message ?? String(e));
    logger.error(
      `run-next: pipeline run failed for "${decision.topic}" (${decision.ns}): ${e?.stack || e}`,
    );
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
