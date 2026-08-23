import type { AccessTokenProvider } from "./google-oauth.js";
import { GoogleOAuthRefreshTokenProvider } from "./google-oauth.js";
import type { StorySource, StorySourceRecord } from "./story-source.js";
import { config } from "../utils/config.js";

type FetchLike = typeof fetch;
type CellValue = string | number | boolean | null;

type SpreadsheetMetadata = {
  sheets?: Array<{
    properties?: { sheetId?: number; title?: string };
  }>;
};

type ValuesResponse = { values?: CellValue[][] };

type Color = { red?: number; green?: number; blue?: number };
type GridCell = {
  effectiveFormat?: {
    backgroundColor?: Color;
    backgroundColorStyle?: { rgbColor?: Color };
  };
};
type GridResponse = {
  sheets?: Array<{
    data?: Array<{
      startRow?: number;
      rowData?: Array<{ values?: GridCell[] }>;
    }>;
  }>;
};

export type GoogleSheetsStorySourceOptions = {
  spreadsheetId?: string;
  sheetGid?: number;
  headerRow?: number;
  fetchImpl?: FetchLike;
  tokenProvider?: AccessTokenProvider;
  random?: () => number;
};

const REQUIRED_HEADERS = [
  "Category",
  "Working Title",
  "Narration Draft",
  "ID",
  "LangGraph ID",
] as const;

const YOUTUBE_EDIT_URL_HEADER = "YouTube Edit URL";

function normalizeHeader(value: CellValue | undefined): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase();
}

function columnLetter(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function quotedSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function isRed(cell: GridCell | undefined): boolean {
  const color =
    cell?.effectiveFormat?.backgroundColorStyle?.rgbColor ??
    cell?.effectiveFormat?.backgroundColor;
  if (!color) return false;
  const red = color.red ?? 0;
  const green = color.green ?? 0;
  const blue = color.blue ?? 0;
  return red >= 0.7 && red - green >= 0.2 && red - blue >= 0.2;
}

function asText(value: CellValue | undefined): string {
  return String(value ?? "").trim();
}

export class GoogleSheetsStorySource implements StorySource {
  private readonly spreadsheetId: string;
  private readonly sheetGid: number;
  private readonly headerRow: number;
  private readonly fetchImpl: FetchLike;
  private readonly tokenProvider: AccessTokenProvider;
  private readonly random: () => number;

  constructor(options: GoogleSheetsStorySourceOptions = {}) {
    const spreadsheetId = options.spreadsheetId ?? config.storySheetId();
    if (!spreadsheetId) {
      throw new Error(
        "STORY_SHEET_ID is required when sheet intake is enabled.",
      );
    }
    this.spreadsheetId = spreadsheetId;
    this.sheetGid = options.sheetGid ?? config.storySheetGid();
    this.headerRow = options.headerRow ?? config.storySheetHeaderRow();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenProvider =
      options.tokenProvider ??
      new GoogleOAuthRefreshTokenProvider(this.fetchImpl);
    this.random = options.random ?? Math.random;
  }

  async reserveRandom(threadId: string): Promise<StorySourceRecord> {
    if (!threadId.trim()) {
      throw new Error(
        "A LangGraph thread_id is required to reserve a sheet row.",
      );
    }

    const token = await this.tokenProvider.getAccessToken();
    const sheetTitle = await this.getSheetTitle(token);
    const rows = await this.getValues(token, sheetTitle);
    const header = rows[this.headerRow - 1] ?? [];
    const columns = new Map(
      header.map((value, index) => [normalizeHeader(value), index]),
    );

    for (const required of REQUIRED_HEADERS) {
      if (!columns.has(required.toLocaleLowerCase())) {
        throw new Error(`Story sheet is missing required column: ${required}`);
      }
    }

    const categoryColumn = columns.get("category")!;
    const titleColumn = columns.get("working title")!;
    const narrationColumn = columns.get("narration draft")!;
    const idColumn = columns.get("id")!;
    const langGraphIdColumn = columns.get("langgraph id")!;
    const idColors = await this.getIdColors(
      token,
      sheetTitle,
      idColumn,
      rows.length,
    );

    const candidates: StorySourceRecord[] = [];
    for (let index = this.headerRow; index < rows.length; index++) {
      const row = rows[index] ?? [];
      const rowNumber = index + 1;
      const category = asText(row[categoryColumn]);
      const workingTitle = asText(row[titleColumn]);
      const narrationDraft = asText(row[narrationColumn]);
      const langGraphId = asText(row[langGraphIdColumn]);
      if (
        langGraphId ||
        isRed(idColors.get(rowNumber)) ||
        !category ||
        !workingTitle ||
        !narrationDraft
      ) {
        continue;
      }
      candidates.push({ rowNumber, category, workingTitle, narrationDraft });
    }

    while (candidates.length > 0) {
      const chosenIndex = Math.min(
        candidates.length - 1,
        Math.floor(this.random() * candidates.length),
      );
      const [chosen] = candidates.splice(chosenIndex, 1);
      const langGraphIdRange = `${quotedSheetTitle(sheetTitle)}!${columnLetter(langGraphIdColumn)}${chosen.rowNumber}`;
      const latest = await this.getRangeValues(token, langGraphIdRange);
      if (asText(latest[0]?.[0])) continue;
      await this.updateValue(token, langGraphIdRange, threadId);
      return chosen;
    }

    throw new Error(
      "No eligible story rows remain (ID must be non-red, LangGraph ID must be empty, and all required fields must be populated).",
    );
  }

  async recordYoutubeEditUrl(threadId: string, editUrl: string): Promise<void> {
    if (!threadId.trim() || !editUrl.trim()) {
      throw new Error(
        "Both thread_id and YouTube edit URL are required to update the story sheet.",
      );
    }

    const token = await this.tokenProvider.getAccessToken();
    const sheetTitle = await this.getSheetTitle(token);
    const rows = await this.getValues(token, sheetTitle);
    const header = rows[this.headerRow - 1] ?? [];
    const columns = new Map(
      header.map((value, index) => [normalizeHeader(value), index]),
    );
    const langGraphIdColumn = columns.get("langgraph id");
    if (langGraphIdColumn === undefined) {
      throw new Error("Story sheet is missing required column: LangGraph ID");
    }

    let youtubeEditUrlColumn = columns.get(
      YOUTUBE_EDIT_URL_HEADER.toLocaleLowerCase(),
    );
    if (youtubeEditUrlColumn === undefined) {
      youtubeEditUrlColumn = header.length;
      const headerRange = `${quotedSheetTitle(sheetTitle)}!${columnLetter(youtubeEditUrlColumn)}${this.headerRow}`;
      await this.updateValue(token, headerRange, YOUTUBE_EDIT_URL_HEADER);
    }

    const matchingRows: number[] = [];
    for (let index = this.headerRow; index < rows.length; index++) {
      if (asText(rows[index]?.[langGraphIdColumn]) === threadId) {
        matchingRows.push(index + 1);
      }
    }
    if (matchingRows.length !== 1) {
      throw new Error(
        `Expected exactly one story row for LangGraph ID ${threadId}, found ${matchingRows.length}.`,
      );
    }

    const rowNumber = matchingRows[0];
    const existing = asText(rows[rowNumber - 1]?.[youtubeEditUrlColumn]);
    if (existing === editUrl) return;
    if (existing) {
      throw new Error(
        `YouTube Edit URL is already populated for LangGraph ID ${threadId}.`,
      );
    }
    const editUrlRange = `${quotedSheetTitle(sheetTitle)}!${columnLetter(youtubeEditUrlColumn)}${rowNumber}`;
    await this.updateValue(token, editUrlRange, editUrl);
  }

  private async requestJson<T>(
    token: string,
    url: string,
    init?: RequestInit,
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(url, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Google Sheets request failed (${response.status}): ${detail || response.statusText}`,
      );
    }
    return (await response.json()) as T;
  }

  private async getSheetTitle(token: string): Promise<string> {
    const fields = encodeURIComponent("sheets(properties(sheetId,title))");
    const metadata = await this.requestJson<SpreadsheetMetadata>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}?fields=${fields}`,
    );
    const sheet = metadata.sheets?.find(
      (item) => item.properties?.sheetId === this.sheetGid,
    );
    const title = sheet?.properties?.title;
    if (!title) {
      throw new Error(
        `Story sheet tab with gid ${this.sheetGid} was not found.`,
      );
    }
    return title;
  }

  private async getValues(
    token: string,
    sheetTitle: string,
  ): Promise<CellValue[][]> {
    return this.getRangeValues(token, quotedSheetTitle(sheetTitle));
  }

  private async getRangeValues(
    token: string,
    range: string,
  ): Promise<CellValue[][]> {
    const response = await this.requestJson<ValuesResponse>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    );
    return response.values ?? [];
  }

  private async getIdColors(
    token: string,
    sheetTitle: string,
    idColumn: number,
    lastRow: number,
  ): Promise<Map<number, GridCell>> {
    if (lastRow <= this.headerRow) return new Map();
    const letter = columnLetter(idColumn);
    const range = `${quotedSheetTitle(sheetTitle)}!${letter}${this.headerRow + 1}:${letter}${lastRow}`;
    const params = new URLSearchParams({
      includeGridData: "true",
      ranges: range,
      fields:
        "sheets(data(startRow,rowData(values(effectiveFormat(backgroundColor,backgroundColorStyle)))))",
    });
    const response = await this.requestJson<GridResponse>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}?${params.toString()}`,
    );
    const result = new Map<number, GridCell>();
    for (const data of response.sheets?.flatMap((sheet) => sheet.data ?? []) ??
      []) {
      const startRow = data.startRow ?? this.headerRow;
      for (const [index, row] of (data.rowData ?? []).entries()) {
        result.set(startRow + index + 1, row.values?.[0] ?? {});
      }
    }
    return result;
  }

  private async updateValue(
    token: string,
    range: string,
    value: string,
  ): Promise<void> {
    await this.requestJson<unknown>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          range,
          majorDimension: "ROWS",
          values: [[value]],
        }),
      },
    );
  }
}
