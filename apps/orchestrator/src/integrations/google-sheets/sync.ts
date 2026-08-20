import { logger } from "../../utils/logger.js";
import { config } from "../../utils/config.js";
import {
  buildSheetRow,
  assertHeaders,
  formatLocalTimestamp,
  type SheetRowRecord,
} from "./sheets-format.mjs";
import type { SheetsValuesApi } from "./client.js";
import { createSheetsClientFromConfig } from "./client.js";
import { toSheetsError } from "./errors.js";
import type { ProjectState } from "../../schemas/index.js";
import type { PublishResult } from "../../providers/publisher/publisher-provider.js";

export interface SyncVideoRecordOptions {
  api: SheetsValuesApi;
  spreadsheetId: string;
  sheetName: string;
  videoId: string;
  record: SheetRowRecord;
}

export interface SyncVideoRecordResult {
  action: "created" | "updated";
  row: number;
}

function boundedRange(sheetName: string): string {
  return `'${sheetName}'!A:K`;
}

function boundedCellRange(sheetName: string, rowNumber: number): string {
  return `'${sheetName}'!A${rowNumber}:K${rowNumber}`;
}

/**
 * Idempotent upsert of one video record keyed on the Video ID column (column A).
 * Reads the full sheet, validates headers, matches an existing row, and either
 * updates it in place or appends a new one. Throws a classified `SheetsError`
 * on any failure so callers decide how to degrade.
 */
export async function syncVideoRecord(
  options: SyncVideoRecordOptions,
): Promise<SyncVideoRecordResult> {
  const { api, spreadsheetId, sheetName, videoId, record } = options;
  try {
    const { data } = await api.get({
      spreadsheetId,
      range: boundedRange(sheetName),
    });
    const rows = data.values ?? [];
    assertHeaders(rows);

    const values = [buildSheetRow(record)];
    const rowIndex = rows.findIndex(
      (row, i) => i > 0 && String(row[0] ?? "").trim() === videoId,
    );

    if (rowIndex >= 0) {
      const rowNumber = rowIndex + 1;
      await api.update({
        spreadsheetId,
        range: boundedCellRange(sheetName, rowNumber),
        valueInputOption: "RAW",
        requestBody: { values },
      });
      return { action: "updated", row: rowNumber };
    }

    await api.append({
      spreadsheetId,
      range: boundedRange(sheetName),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
    return { action: "created", row: rows.length + 1 };
  } catch (error) {
    throw toSheetsError(error);
  }
}

/**
 * Post-publish sync: write every platform result back to the sheet. Never
 * throws — Sheets is a best-effort side effect of an already-successful
 * publish and must not fail the publish. Missing spreadsheetId or projectId
 * is logged and skipped (projectId is seeded by `run-next.mjs`).
 */
export async function syncPublishResults(options: {
  state: ProjectState;
  results: PublishResult[];
  publishAt?: string;
  api?: SheetsValuesApi;
}): Promise<void> {
  const { state, results, publishAt, api: injectedApi } = options;
  const spreadsheetId = config.googleSheetsSpreadsheetId();

  const api =
    injectedApi ?? (spreadsheetId ? createSheetsClientFromConfig() : undefined);
  if (!api || !spreadsheetId) return;

  const projectId = state.project?.projectId;
  if (!projectId) {
    logger.warn(
      "Google Sheets sync skipped: project has no projectId (seeded by run-next.mjs)",
    );
    return;
  }

  const sheetName = config.googleSheetsSheetName();
  const category = state.metadataOutput?.category;
  const topic = state.project?.topic;
  const title = state.metadataOutput?.title;
  const privacy = config.youtubePrivacyStatus();
  const durationMs = state.video?.durationMs;

  for (const result of results) {
    if (!result.platformVideoId) continue;
    try {
      const record: SheetRowRecord = {
        videoId: projectId,
        category,
        topic,
        title,
        status: result.status,
        youtubeId: result.platformVideoId,
        privacy,
        scheduledAt:
          result.status === "scheduled" && publishAt
            ? formatLocalTimestamp(publishAt)
            : "",
        publishedAt: result.status === "published" ? result.publishedAt : "",
        durationMs,
      };
      const outcome = await syncVideoRecord({
        api,
        spreadsheetId,
        sheetName,
        videoId: projectId,
        record,
      });
      logger.info(
        `Google Sheets ${outcome.action} row ${outcome.row} for video ${projectId}`,
        { status: result.status, platformVideoId: result.platformVideoId },
      );
    } catch (error) {
      const classified =
        error instanceof Error && "info" in error
          ? (error as { info: { code: string; retryable: boolean } }).info
          : { code: "unknown", retryable: false };
      logger.error(`Google Sheets sync failed for video ${projectId}`, {
        code: classified.code,
        retryable: classified.retryable,
      });
    }
  }
}
