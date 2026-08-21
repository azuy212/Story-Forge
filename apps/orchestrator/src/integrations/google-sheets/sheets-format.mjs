/**
 * Shared pure helpers for the Google Sheets integration.
 *
 * Plain ESM (`.mjs`) so both the TS integration and the `run-next.mjs` CLI
 * can use the same column layout, header contract, backlog selection, and
 * slot math without a TS import coupling (mirrors `artifacts/run-meta.mjs`).
 * No googleapis / no auth / no env access here.
 */

export const EXPECTED_HEADERS = [
  "Video ID",
  "Category",
  "Topic",
  "Title",
  "Status",
  "YouTube ID",
  "YouTube URL",
  "Privacy",
  "Scheduled At",
  "Published At",
  "Duration",
  "LLM Prompt Tokens",
  "LLM Completion Tokens",
  "LLM Total Tokens",
  "LLM Reasoning Tokens",
  "LLM Cached Tokens",
  "LLM Cost USD",
];

export const COLUMN = {
  VIDEO_ID: 0,
  CATEGORY: 1,
  TOPIC: 2,
  TITLE: 3,
  STATUS: 4,
  YOUTUBE_ID: 5,
  YOUTUBE_URL: 6,
  PRIVACY: 7,
  SCHEDULED_AT: 8,
  PUBLISHED_AT: 9,
  DURATION: 10,
  LLM_PROMPT_TOKENS: 11,
  LLM_COMPLETION_TOKENS: 12,
  LLM_TOTAL_TOKENS: 13,
  LLM_REASONING_TOKENS: 14,
  LLM_CACHED_TOKENS: 15,
  LLM_COST_USD: 16,
};

export const PLANNED_STATUS = "planned";

export const SLOT_HOURS = [12, 20];

/**
 * Validate the first row of the sheet. Throws a descriptive error on
 * mismatch so callers fail closed instead of writing into an unexpected
 * layout.
 */
export function assertHeaders(rows) {
  const header = (rows[0] ?? []).map((cell) => String(cell ?? "").trim());
  const mismatch =
    header.length !== EXPECTED_HEADERS.length ||
    header.some((cell, i) => cell !== EXPECTED_HEADERS[i]);
  if (mismatch) {
    throw new Error(
      `Google Sheets header mismatch: expected [${EXPECTED_HEADERS.join(", ")}], got [${header.join(", ")}]`,
    );
  }
}

/**
 * First backlog row with Status "planned" and non-empty Video ID, Category,
 * and Topic. Planned rows missing any required field are skipped and reported
 * through `log` so a malformed row can never seed an invalid project. Rows
 * are 1-based sheet positions; the header row is row 1.
 *
 * @returns {null | { videoId: string, category: string, topic: string, rowIndex: number }}
 */
export function pickPendingRow(rows, log = () => {}) {
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const status = String(row[COLUMN.STATUS] ?? "").trim();
    if (status !== PLANNED_STATUS) continue;

    const videoId = String(row[COLUMN.VIDEO_ID] ?? "").trim();
    const category = String(row[COLUMN.CATEGORY] ?? "").trim();
    const topic = String(row[COLUMN.TOPIC] ?? "").trim();

    const missing = [];
    if (!videoId) missing.push("Video ID");
    if (!category) missing.push("Category");
    if (!topic) missing.push("Topic");

    if (missing.length > 0) {
      log(`row ${i + 1}: skipped planned row, missing ${missing.join(", ")}`);
      continue;
    }

    return { videoId, category, topic, rowIndex: i + 1 };
  }
  return null;
}

/**
 * Earliest future publish slot from {12:00, 20:00} local time, day by day,
 * that is not already occupied by a scheduled row's `Scheduled At`.
 *
 * ponytail: slot "local time" = server local timezone; pin TZ in the
 * deployment environment so the schedule does not drift with the host.
 *
 * @param {string[]} scheduledAtValues ISO strings from rows already scheduled.
 * @param {Date} now
 * @returns {string | null} ISO-8601 slot, or null if none found within 30 days.
 */
export function nextPublishSlot(scheduledAtValues = [], now = new Date()) {
  const occupied = new Set(
    scheduledAtValues
      .filter(Boolean)
      .map((value) => new Date(value).setMinutes(0, 0, 0)),
  );

  for (let day = 0; day < 30; day++) {
    for (const hour of SLOT_HOURS) {
      const slot = new Date(now);
      slot.setDate(slot.getDate() + day);
      slot.setHours(hour, 0, 0, 0);
      const key = slot.setMinutes(0, 0, 0);
      if (key <= now.getTime()) continue;
      if (occupied.has(key)) continue;
      return slot.toISOString();
    }
  }
  return null;
}

function padNumber(n) {
  return String(n).padStart(2, "0");
}

/**
 * Render a duration in milliseconds as `H:MM:SS` (e.g. `0:01:14`). Empty
 * string when the duration is absent or non-positive.
 */
export function formatDurationMs(ms) {
  if (ms == null || Number.isNaN(Number(ms)) || Number(ms) <= 0) return "";
  const totalSeconds = Math.floor(Number(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${padNumber(minutes)}:${padNumber(seconds)}`;
}

/**
 * Render an ISO-8601 timestamp as a local `M/D/YYYY H:MM:SS` string
 * (e.g. `8/21/2026 12:00:00`). Empty string when absent or invalid.
 */
export function formatLocalTimestamp(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${date.getHours()}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`;
}

/**
 * Build one canonical 17-cell row for a video record.
 */
export function buildSheetRow(record) {
  const youtubeUrl = record.youtubeId
    ? `https://www.youtube.com/watch?v=${record.youtubeId}`
    : "";
  return [
    record.videoId ?? "",
    record.category ?? "",
    record.topic ?? "",
    record.title ?? "",
    record.status ?? "",
    record.youtubeId ?? "",
    youtubeUrl,
    record.privacy ?? "",
    record.scheduledAt ?? "",
    record.publishedAt ?? "",
    formatDurationMs(record.durationMs),
    record.llmPromptTokens ?? "",
    record.llmCompletionTokens ?? "",
    record.llmTotalTokens ?? "",
    record.llmReasoningTokens ?? "",
    record.llmCachedTokens ?? "",
    record.llmCostUsd ?? "",
  ];
}
