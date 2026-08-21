export const EXPECTED_HEADERS: string[];
export const COLUMN: {
  VIDEO_ID: number;
  CATEGORY: number;
  TOPIC: number;
  TITLE: number;
  STATUS: number;
  YOUTUBE_ID: number;
  YOUTUBE_URL: number;
  PRIVACY: number;
  SCHEDULED_AT: number;
  PUBLISHED_AT: number;
  DURATION: number;
  LLM_PROMPT_TOKENS: number;
  LLM_COMPLETION_TOKENS: number;
  LLM_TOTAL_TOKENS: number;
  LLM_REASONING_TOKENS: number;
  LLM_CACHED_TOKENS: number;
  LLM_COST_USD: number;
};
export const PLANNED_STATUS: "planned";
export const SLOT_HOURS: number[];

export function assertHeaders(rows: (string | number | boolean)[][]): void;

export function pickPendingRow(
  rows: (string | number | boolean)[][],
  log?: (message: string) => void,
): {
  videoId: string;
  category: string;
  topic: string;
  rowIndex: number;
} | null;

export function nextPublishSlot(
  scheduledAtValues?: string[],
  now?: Date,
): string | null;

export function formatDurationMs(ms: number | null | undefined): string;

export function formatLocalTimestamp(iso: string | null | undefined): string;

export interface SheetRowRecord {
  videoId?: string;
  category?: string;
  topic?: string;
  title?: string;
  status?: string;
  youtubeId?: string;
  privacy?: string;
  scheduledAt?: string;
  publishedAt?: string;
  durationMs?: number | null;
  llmPromptTokens?: number;
  llmCompletionTokens?: number;
  llmTotalTokens?: number;
  llmReasoningTokens?: number;
  llmCachedTokens?: number;
  llmCostUsd?: number;
}

export function buildSheetRow(record: SheetRowRecord): (string | number)[];
