#!/usr/bin/env node
// Backlog-driven run launcher.
//
// Reads the Google Sheets backlog, picks the first valid "planned" row
// (Video ID + Category + Topic), then:
//   - if a run already exists for that topic, resumes it from its persisted
//     state (no new publish slot is assigned; the run's persisted projectId
//     is preserved),
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
import { randomBytes } from "node:crypto";
import googleapis from "googleapis";
import dotenv from "dotenv";
import {
  assertHeaders,
  pickPendingRow,
  nextPublishSlot,
  COLUMN,
} from "../src/integrations/google-sheets/sheets-format.mjs";
import { getAssistantId, resumeRun } from "./resume.mjs";

const { google } = googleapis;

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = fileURLToPath(new URL("../.env", import.meta.url));

// Load .env first: RUNS_DIR and every credential derive from the env.
dotenv.config({ path: envPath });

const RUNS_DIR =
  process.env.ARTIFACT_STORE_DIR || join(__dirname, "..", "runs");

function fail(message) {
  console.error(`run-next: ${message}`);
  process.exit(1);
}

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
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function buildNamespace(topic) {
  const stamp = formatRunStamp();
  const hex = randomBytes(2).toString("hex");
  return `${slugify(topic)}-${stamp}-${hex}`;
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
 * @param {(string | number | boolean)[][]} rows full sheet A:K values
 * @returns {object} decision:
 *   - { action: "none", reason: "no-pending-row" | "no-slot" }
 *   - { action: "resume", ns, pillar, topic, projectId }
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
  if (existing) {
    return {
      action: "resume",
      ns: existing.ns,
      pillar: existing.meta.pillar,
      topic: existing.meta.topic,
      // Preserve the run's persisted Sheet identity; fall back to the current
      // backlog row only for legacy runs created before projectId was stored.
      projectId: existing.meta.projectId ?? pending.videoId,
    };
  }

  const slot = nextPublishSlot(scheduledAtValues, now);
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

async function readSheetRows(client, spreadsheetId, sheetName) {
  const res = await client.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A:K`,
  });
  return res.data?.values ?? [];
}

async function main() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || "Sheet1";

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
    rows = await readSheetRows(sheets, spreadsheetId, sheetName);
  } catch (e) {
    fail(`reading sheet failed: ${e.message}`);
  }

  try {
    assertHeaders(rows);
  } catch (e) {
    fail(e.message);
  }

  const decision = decideRun(RUNS_DIR, rows);
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
    assistantId = await getAssistantId();
  } catch (e) {
    fail(`getAssistantId failed: ${e.message}`);
  }

  if (decision.action === "resume") {
    console.log(
      `Resuming existing run for topic "${decision.topic}": ${decision.ns}`,
    );
    console.log("  No new publish slot assigned (preserving persisted state).");
    await resumeRun(
      decision.ns,
      { pillar: decision.pillar, topic: decision.topic },
      { assistantId, projectId: decision.projectId },
    );
    console.log(`\nArtifacts in: runs/${decision.ns}`);
    return;
  }

  console.log(
    `New backlog run "${decision.topic}" (video ${decision.projectId}) at slot ${decision.youtubePublishAt}`,
  );
  await resumeRun(
    decision.ns,
    { pillar: decision.pillar, topic: decision.topic },
    {
      assistantId,
      projectId: decision.projectId,
      youtubePublishAt: decision.youtubePublishAt,
    },
  );
  console.log(`\nArtifacts in: runs/${decision.ns}`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]).href)
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
