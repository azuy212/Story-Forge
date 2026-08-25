#!/usr/bin/env node
// Backlog-driven run launcher.
//
// Reads the Google Sheets backlog, picks the first valid "planned" row
// (Video ID + Category + Topic), then:
//   - if a run already exists for that topic, resumes it from its persisted
//     state (the run's persisted projectId is preserved; the next free
//     12:00 / 20:00 publish slot is (re)seeded so a resumed run still
//     publishes at a valid schedule time),
//   - otherwise creates a new run seeded with the row's projectId, pillar
//     (Category), topic, and the next free 12:00 / 20:00 publish slot.
//
// Requires the LangGraph dev server (pnpm dev) and a sheet whose row 1 is the
// canonical header. Auth reuses the YOUTUBE_* OAuth credentials and must
// carry the spreadsheets scope (see scripts/oauth-youtube.mjs).
//
// Usage (from apps/orchestrator):
//   node scripts/run-next.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import googleapis from "googleapis";
import dotenv from "dotenv";
import {
  assertHeaders,
  pickPendingRow,
  nextPublishSlot,
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

function fail(message) {
  throw new LauncherError(message);
}

/**
 * Fatal launcher/configuration failure: missing credentials, bad sheet
 * config, unreadable sheet, invalid headers, unavailable assistant.
 * The entrypoint maps this to exit code 1.
 */
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

/**
 * Pure decision step of the runner, separated from I/O so it is unit-testable.
 *
 * @param {string} runsDir artifact store root
 * @param {(string | number | boolean)[][]} rows full sheet A:Q values
 * @param {Date} [now] current time for slot calculation
 * @returns {object} decision:
 *   - { action: "none", reason: "no-pending-row" | "no-slot" }
 *   - { action: "resume", ns, pillar, topic, projectId, youtubePublishAt? }
 *   - { action: "create", ns, pillar, topic, projectId, youtubePublishAt }
 */
export function decideRun(runsDir, rows, now = new Date()) {
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
  const slot = nextPublishSlot(scheduledAtValues, now);
  if (existing) {
    return {
      action: "resume",
      ns: existing.ns,
      pillar: existing.meta.pillar,
      topic: existing.meta.topic,
      // Preserve the run's persisted Sheet identity; fall back to the current
      // backlog row only for legacy runs created before projectId was stored.
      projectId: existing.meta.projectId ?? pending.videoId,
      // (Re)seed the next free slot so a resumed run still publishes at a
      // valid schedule time. May be absent when every slot is taken within 30
      // days; the resume proceeds regardless.
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

// Inline buildSummary to avoid test module resolution issues
function buildSummary(data) {
  if (!data) return undefined;
  
  const parts = [];
  
  const scenes = data.production?.scenes?.length;
  if (scenes) parts.push(`${scenes} scenes`);
  
  const duration = data.video?.durationSec;
  if (duration !== undefined) parts.push(`${duration.toFixed(1)}s`);
  
  const sceneAssets = data.production?.scenes;
  if (sceneAssets) {
    const assets = sceneAssets.filter((s) => s.generationStatus === "complete" && s.assetUrl).length;
    if (assets) parts.push(`${assets} assets`);
  }
  
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Full launcher lifecycle: read backlog → decide create/resume → obtain
 * assistant → dispatch and wait for ONE graph run → finalize.
 *
 * Launcher/configuration failures (credentials, sheet access, headers,
 * assistant lookup) throw LauncherError and are fatal (exit 1). A failure of
 * the pipeline run itself is recoverable: it is logged with the run's
 * namespace/topic and the launcher finishes normally (exit 0); what happens
 * on the next invocation is decided by the backlog and the run's persisted
 * state, not by this launcher. The LangGraph server is never owned by this
 * process; once the dispatched run reaches its terminal state, this returns
 * and Node exits naturally.
 *
 * Deps are injectable for tests; defaults read env, Google Sheets, and hit
 * the real dev server.
 */
export async function runLauncher({
  env = process.env,
  runsDir = RUNS_DIR,
  readRows = readSheetRows,
  getAssistantId: getAssistant = getAssistantId,
  resumeRun: runPipeline = resumeRun,
} = {}) {
  const clientId = env.YOUTUBE_CLIENT_ID;
  const clientSecret = env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = env.YOUTUBE_REFRESH_TOKEN;
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const sheetName = env.GOOGLE_SHEETS_SHEET_NAME || "Sheet1";

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

  const decision = decideRun(runsDir, rows);
  if (decision.action === "none") {
    console.log(
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

  const input = { pillar: decision.pillar, topic: decision.topic };
  const options = {
    assistantId,
    projectId: decision.projectId,
    youtubePublishAt: decision.youtubePublishAt,
  };

  // Calculate attempt from persisted metadata (same logic as resume.mjs)
  const existing = findRunByTopic(runsDir, decision.topic);
  const attempt = existing ? (existing.meta?.threadHistory?.length ?? 0) + 1 : 1;
  logger.setRunContext(decision.ns, decision.topic, attempt);

  try {
    if (decision.action === "resume") {
      logger.info(`Resuming existing run for topic "${decision.topic}": ${decision.ns}`);
      if (decision.youtubePublishAt) {
        logger.info(`  (Re)seeding publish slot ${decision.youtubePublishAt} for this resume.`);
      } else {
        logger.info("  No free publish slot within 30 days; publishing as-is.");
      }
    } else {
      logger.info(`New backlog run "${decision.topic}" (video ${decision.projectId}) at slot ${decision.youtubePublishAt}`);
    }
    // Resolves only when this specific graph run reached its terminal state.
    const { lastEvent } = await runPipeline(decision.ns, input, options);
    const status = lastEvent?.data?.execution?.status === "complete" ? "complete" : "failed";
    const summary = buildSummary(lastEvent?.data);
    logger.finalize(status, summary);
    logger.info(`Artifacts in: runs/${decision.ns}`);
  } catch (e) {
    // Recoverable pipeline failure: log it and finalize normally (exit 0).
    // Whatever state this run persisted stays authoritative; whether a later
    // invocation can resume depends on that state, not on this launcher.
    logger.finalize("failed", e?.message ?? String(e));
    logger.error(`run-next: pipeline run failed for "${decision.topic}" (${decision.ns}): ${e?.stack || e}`);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]).href)
) {
  runLauncher().catch((e) => {
    if (e instanceof LauncherError) {
      console.error(`run-next: ${e.message}`);
    } else {
      console.error(e?.stack || e);
    }
    process.exitCode = 1;
  });
}
