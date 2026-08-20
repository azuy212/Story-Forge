import { jest, describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import {
  syncVideoRecord,
  syncPublishResults,
  classifySheetsError,
  SheetsError,
} from "../src/integrations/google-sheets/index.js";
import {
  buildSheetRow,
  formatDurationMs,
  formatLocalTimestamp,
  EXPECTED_HEADERS,
} from "../src/integrations/google-sheets/sheets-format.mjs";

function makeApi() {
  return {
    get: jest.fn<
      () => Promise<{ data: { values?: (string | number | boolean)[][] } }>
    >(),
    update: jest.fn<() => Promise<{ data: unknown }>>(),
    append: jest.fn<() => Promise<{ data: unknown }>>(),
  } as any;
}

function headerRow(): string[] {
  return [...EXPECTED_HEADERS];
}

describe("syncVideoRecord", () => {
  const baseOptions = {
    spreadsheetId: "sheet-1",
    sheetName: "Sheet1",
    videoId: "abc123",
    record: {
      videoId: "abc123",
      category: "Geography",
      topic: "Unrecognized Countries",
      title: "Title",
      status: "scheduled",
      youtubeId: "yt-1",
      privacy: "private",
      scheduledAt: "2026-08-20T12:00:00.000Z",
      durationMs: 65000,
    },
  };

  it("appends a new row when the video id is not present", async () => {
    const api = makeApi();
    api.get.mockResolvedValue({ data: { values: [headerRow()] } });
    api.append.mockResolvedValue({ data: {} });

    const result = await syncVideoRecord({ ...baseOptions, api });

    expect(result).toEqual({ action: "created", row: 2 });
    expect(api.update).not.toHaveBeenCalled();
    expect(api.append).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-1",
        range: "'Sheet1'!A:K",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [
            [
              "abc123",
              "Geography",
              "Unrecognized Countries",
              "Title",
              "scheduled",
              "yt-1",
              "https://www.youtube.com/watch?v=yt-1",
              "private",
              "2026-08-20T12:00:00.000Z",
              "",
              "0:01:05",
            ],
          ],
        },
      }),
    );
  });

  it("updates the matching row in place when the video id exists", async () => {
    const api = makeApi();
    api.get.mockResolvedValue({
      data: {
        values: [
          headerRow(),
          [
            "abc123",
            "Geography",
            "Old Topic",
            "",
            "planned",
            "",
            "",
            "",
            "",
            "",
            "",
          ],
        ],
      },
    });
    api.update.mockResolvedValue({ data: {} });

    const result = await syncVideoRecord({ ...baseOptions, api });

    expect(result).toEqual({ action: "updated", row: 2 });
    expect(api.append).not.toHaveBeenCalled();
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({
        range: "'Sheet1'!A2:K2",
        valueInputOption: "RAW",
      }),
    );
  });

  it("throws a classified SheetsError on header mismatch", async () => {
    const api = makeApi();
    api.get.mockResolvedValue({ data: { values: [["Wrong", "Headers"]] } });

    await expect(syncVideoRecord({ ...baseOptions, api })).rejects.toThrow(
      SheetsError,
    );
  });

  it("throws a classified SheetsError on api failure", async () => {
    const api = makeApi();
    api.get.mockRejectedValue({ code: 403, message: "forbidden" });

    await expect(
      syncVideoRecord({ ...baseOptions, api }),
    ).rejects.toMatchObject({ info: { code: "forbidden", retryable: false } });
  });
});

describe("buildSheetRow", () => {
  it("renders the canonical 11-cell row", () => {
    const row = buildSheetRow({
      videoId: "abc123",
      category: "Geography",
      topic: "Topic",
      title: "Title",
      status: "published",
      youtubeId: "yt-9",
      privacy: "public",
      publishedAt: "2026-08-20T12:00:00.000Z",
      durationMs: 65000,
    });
    expect(row).toEqual([
      "abc123",
      "Geography",
      "Topic",
      "Title",
      "published",
      "yt-9",
      "https://www.youtube.com/watch?v=yt-9",
      "public",
      "",
      "2026-08-20T12:00:00.000Z",
      "0:01:05",
    ]);
  });

  it("leaves timestamps and duration empty when not applicable", () => {
    const row = buildSheetRow({
      videoId: "abc123",
      status: "planned",
    });
    expect(row[8]).toBe("");
    expect(row[9]).toBe("");
    expect(row[10]).toBe("");
  });
});

describe("formatDurationMs", () => {
  it("formats MM:SS under an hour", () => {
    expect(formatDurationMs(65000)).toBe("0:01:05");
  });
  it("formats HH:MM:SS at an hour or more", () => {
    expect(formatDurationMs(3725000)).toBe("1:02:05");
  });
  it("returns empty string for absent or non-positive values", () => {
    expect(formatDurationMs(undefined)).toBe("");
    expect(formatDurationMs(null)).toBe("");
    expect(formatDurationMs(0)).toBe("");
    expect(formatDurationMs(-5)).toBe("");
  });
});

describe("formatLocalTimestamp", () => {
  it("renders a local M/D/YYYY H:MM:SS string", () => {
    const formatted = formatLocalTimestamp("2026-08-21T12:00:00.000Z");
    const date = new Date("2026-08-21T12:00:00.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(formatted).toBe(
      `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${date.getHours()}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    );
  });

  it("returns empty string for absent or invalid values", () => {
    expect(formatLocalTimestamp(undefined)).toBe("");
    expect(formatLocalTimestamp("")).toBe("");
    expect(formatLocalTimestamp("not-a-date")).toBe("");
  });
});

describe("classifySheetsError", () => {
  it("classifies network errors as retryable", () => {
    expect(
      classifySheetsError({ code: "ECONNRESET", message: "reset" }),
    ).toMatchObject({ code: "network_error", retryable: true });
  });
  it("classifies forbidden as non-retryable", () => {
    expect(
      classifySheetsError({ code: 403, message: "forbidden" }),
    ).toMatchObject({ code: "forbidden", retryable: false });
  });
  it("classifies 5xx as retryable backend errors", () => {
    expect(
      classifySheetsError({ status: 503, message: "unavailable" }),
    ).toMatchObject({ code: "backend_error", retryable: true });
  });
});

describe("syncPublishResults", () => {
  const previousId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const previousSheet = process.env.GOOGLE_SHEETS_SHEET_NAME;
  beforeAll(() => {
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID = "spreadsheet-sync";
    process.env.GOOGLE_SHEETS_SHEET_NAME = "Sheet1";
  });
  afterAll(() => {
    if (previousId === undefined) {
      delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    } else {
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID = previousId;
    }
    if (previousSheet === undefined) {
      delete process.env.GOOGLE_SHEETS_SHEET_NAME;
    } else {
      process.env.GOOGLE_SHEETS_SHEET_NAME = previousSheet;
    }
  });

  function baseState(projectId = "abc123"): any {
    return {
      project: { pillar: "Geography", topic: "Topic", projectId },
      metadataOutput: {
        title: "A Title",
        category: "Geography",
        description: "D",
        tags: [],
        hashtags: [],
        pinnedComment: "C",
      },
      video: { durationMs: 65000 },
      execution: { version: "0.1.0" },
    };
  }

  function pubResult(
    status: string,
    videoId: string,
    publishedAt: string,
  ): any {
    return {
      platform: "youtube",
      platformVideoId: videoId,
      url: `https://youtu.be/${videoId}`,
      status,
      publishedAt,
    };
  }

  function makeMutableApi() {
    const rows = [EXPECTED_HEADERS];
    return {
      get: jest.fn(() => Promise.resolve({ data: { values: rows } })),
      append: jest.fn(async ({ requestBody }) => {
        for (const v of requestBody.values) rows.push(v);
        return { data: {} };
      }),
      update: jest.fn(async ({ range, requestBody }) => {
        const idx = Number(range.match(/!A(\d+):K(\d+)$/)[1]) - 1;
        rows[idx] = requestBody.values[0];
        return { data: {} };
      }),
    };
  }

  it("maps a published result (Published At set, Scheduled At empty)", async () => {
    const api = makeMutableApi();
    await syncPublishResults({
      state: baseState(),
      results: [pubResult("published", "yt-1", "2026-08-20T12:00:00.000Z")],
      publishAt: "2026-08-20T12:00:00.000Z",
      api: api as any,
    });

    expect(api.append).toHaveBeenCalledTimes(1);
    const { requestBody } = api.append.mock.calls[0][0];
    expect(requestBody.values[0]).toEqual([
      "abc123",
      "Geography",
      "Topic",
      "A Title",
      "published",
      "yt-1",
      "https://www.youtube.com/watch?v=yt-1",
      "private",
      "",
      "2026-08-20T12:00:00.000Z",
      "0:01:05",
    ]);
  });

  it("maps a scheduled result (Scheduled At set, Published At empty)", async () => {
    const api = makeMutableApi();
    await syncPublishResults({
      state: baseState(),
      results: [pubResult("scheduled", "yt-2", "")],
      publishAt: "2026-08-20T12:00:00.000Z",
      api: api as any,
    });

    const { requestBody } = api.append.mock.calls[0][0];
    expect(requestBody.values[0][8]).toBe(formatLocalTimestamp("2026-08-20T12:00:00.000Z"));
    expect(requestBody.values[0][9]).toBe("");
  });

  it("syncs every result in the list", async () => {
    const api = makeMutableApi();
    await syncPublishResults({
      state: baseState("multi-1"),
      results: [
        pubResult("published", "yt-1", "2026-08-20T12:00:00.000Z"),
        {
          ...pubResult("published", "tk-1", "2026-08-20T12:00:00.000Z"),
          platform: "tiktok",
        },
      ],
      api: api as any,
    });

    expect(api.append).toHaveBeenCalledTimes(1);
    expect(api.append.mock.calls[0][0].requestBody.values[0][5]).toBe("yt-1");
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][0].requestBody.values[0][5]).toBe("tk-1");
  });

  it("updates instead of duplicating on an idempotent repeat", async () => {
    const api = makeMutableApi();
    const result = [pubResult("published", "yt-1", "2026-08-20T12:00:00.000Z")];

    await syncPublishResults({
      state: baseState(),
      results: result,
      api: api as any,
    });
    expect(api.append).toHaveBeenCalledTimes(1);

    await syncPublishResults({
      state: baseState(),
      results: result,
      api: api as any,
    });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.append).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a spreadsheet id", async () => {
    const previous = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const api = makeMutableApi();
    try {
      await syncPublishResults({
        state: baseState(),
        results: [pubResult("published", "yt-1", "")],
        api: api as any,
      });
      expect(api.get).not.toHaveBeenCalled();
    } finally {
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID = previous;
    }
  });
});
