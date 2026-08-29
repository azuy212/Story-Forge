import { logger } from "../../utils/logger.js";
import { config } from "../../utils/config.js";
import { appendRunLogEvent, getRunLogSink } from "../../utils/run-log.js";
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
import type { LLMAggregate } from "../../models/usage.js";

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
  return `'${sheetName}'!A:Q`;
}

function boundedCellRange(sheetName: string, rowNumber: number): string {
  return `'${sheetName}'!A${rowNumber}:Q${rowNumber}`;
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
  const sink = getRunLogSink(logger.getCurrentSink()?.runId ?? "") ?? logger.getCurrentSink();
  const startedAt = Date.now();
  const event: Record<string, unknown> = {
    event: "provider_call",
    provider: "google_sheets",
    operation: "sync_video_record",
    url: "googleapis.com/sheets/v4/values",
    method: "POST",
    headers: {},
    spreadsheetId,
    sheetName,
    videoId,
  };
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
      event.action = "update";
      await api.update({
        spreadsheetId,
        range: boundedCellRange(sheetName, rowNumber),
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });
      event.row = rowNumber;
      event.requestDurationMs = Date.now() - startedAt;
      appendRunLogEvent(sink, event);
      return { action: "updated", row: rowNumber };
    }

    event.action = "append";
    await api.append({
      spreadsheetId,
      range: boundedRange(sheetName),
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
    event.row = rows.length + 1;
    event.requestDurationMs = Date.now() - startedAt;
    appendRunLogEvent(sink, event);
    return { action: "created", row: rows.length + 1 };
  } catch (error) {
    event.requestDurationMs = Date.now() - startedAt;
    event.error = {
      message: (error as Error)?.message ?? String(error),
      name: (error as Error)?.name,
    };
    appendRunLogEvent(sink, event);
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
  usage?: LLMAggregate;
  api?: SheetsValuesApi;
}): Promise<void> {
  const { state, results, publishAt, usage, api: injectedApi } = options;
  const spreadsheetId = config.googleSheetsSpreadsheetId();

  const api =
    injectedApi ?? (spreadsheetId ? createSheetsClientFromConfig() : undefined);
  if (!api || !spreadsheetId) return;

  const projectId = state.project?.projectId;
  if (!projectId) {
    logger.warn(
      "Google Sheets sync skipped: project has no projectId (seeded by run-next.mjs or --project-id)",
    );
    return;
  }

  const sheetName = config.googleSheetsSheetNameForSource(
    state.project?.runSource,
    state.videoProfile?.profile,
  );
  const category = state.project?.pillar ?? state.metadataOutput?.category;
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
        llmPromptTokens: usage?.llmPromptTokens,
        llmCompletionTokens: usage?.llmCompletionTokens,
        llmTotalTokens: usage?.llmTotalTokens,
        llmReasoningTokens: usage?.llmReasoningTokens,
        llmCachedTokens: usage?.llmCachedTokens,
        llmCostUsd: usage?.llmCostUsd,
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
