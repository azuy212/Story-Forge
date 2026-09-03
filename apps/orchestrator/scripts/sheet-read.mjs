#!/usr/bin/env node
// Read-only sheet dump for the admin-ui.
//
// Reuses the same OAuth client + sheets-format helpers as run-next.mjs so
// auth stays in apps/orchestrator/.env and we don't pull googleapis into
// admin-ui. Returns JSON to stdout for the admin-ui server to parse.
//
// Usage:
//   node scripts/sheet-read.mjs                 -> { short: {headers, rows}, long: {...} }
//   node scripts/sheet-read.mjs --profile short -> just one profile
import dotenv from "dotenv";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import googleapis from "googleapis";
import { Command } from "commander";
import { COLUMN, formatLocalTimestamp } from "../src/integrations/google-sheets/sheets-format.mjs";

const { google } = googleapis;

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
dotenv.config({ path: envPath, quiet: true });

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_SHORT = process.env.GOOGLE_SHEETS_SHEET_NAME || "Sheet1";
const SHEET_LONG = process.env.GOOGLE_SHEETS_SHEET_NAME_LONG || "Long Videos";

const PROFILES = {
  short: SHEET_SHORT,
  long: SHEET_LONG,
};

function toRecord(row) {
  const r = row ?? [];
  const num = (i) => {
    const v = r[i];
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    videoId: r[COLUMN.VIDEO_ID] ?? "",
    category: r[COLUMN.CATEGORY] ?? "",
    topic: r[COLUMN.TOPIC] ?? "",
    title: r[COLUMN.TITLE] ?? "",
    status: r[COLUMN.STATUS] ?? "",
    youtubeId: r[COLUMN.YOUTUBE_ID] ?? "",
    youtubeUrl: r[COLUMN.YOUTUBE_URL] ?? "",
    privacy: r[COLUMN.PRIVACY] ?? "",
    scheduledAt: r[COLUMN.SCHEDULED_AT] ?? "",
    scheduledAtLocal: formatLocalTimestamp(r[COLUMN.SCHEDULED_AT] ?? ""),
    publishedAt: r[COLUMN.PUBLISHED_AT] ?? "",
    publishedAtLocal: formatLocalTimestamp(r[COLUMN.PUBLISHED_AT] ?? ""),
    duration: r[COLUMN.DURATION] ?? "",
    llm: {
      promptTokens: num(COLUMN.LLM_PROMPT_TOKENS),
      completionTokens: num(COLUMN.LLM_COMPLETION_TOKENS),
      totalTokens: num(COLUMN.LLM_TOTAL_TOKENS),
      reasoningTokens: num(COLUMN.LLM_REASONING_TOKENS),
      cachedTokens: num(COLUMN.LLM_CACHED_TOKENS),
      costUsd: num(COLUMN.LLM_COST_USD),
    },
  };
}

async function readProfile(client, profile) {
  const sheetName = PROFILES[profile];
  if (!sheetName) throw new Error(`unknown profile: ${profile}`);
  const res = await client.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A:Q`,
  });
  const rows = res.data?.values ?? [];
  const records = rows.slice(1).map(toRecord).filter((r) => r.videoId || r.topic);
  return { sheetName, records };
}

async function main() {
  const program = new Command();
  program
    .name("sheet-read")
    .option("--profile <short|long>", "single profile", "");
  program.parse(process.argv);
  const { profile } = program.opts();

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!SPREADSHEET_ID) {
    throw new Error("missing GOOGLE_SHEETS_SPREADSHEET_ID");
  }
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN",
    );
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const sheets = google.sheets({ version: "v4", auth: oauth2 });

  const out = { fetchedAt: new Date().toISOString() };
  if (profile) {
    out[profile] = await readProfile(sheets, profile);
  } else {
    for (const p of Object.keys(PROFILES)) {
      try {
        out[p] = await readProfile(sheets, p);
      } catch (e) {
        out[p] = { sheetName: PROFILES[p], error: e.message, records: [] };
      }
    }
  }

  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  process.stderr.write(`sheet-read: ${e.message}\n`);
  process.exit(1);
});