import { describe, expect, it, jest } from "@jest/globals";
import { GoogleSheetsStorySource } from "../src/providers/google-sheets-story-source.js";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GoogleSheetsStorySource", () => {
  it("skips populated and red ID cells, then reserves an eligible row", async () => {
    const updates: unknown[] = [];
    const fetchImpl = jest.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") {
        updates.push(JSON.parse(String(init.body)));
        return json({ updatedCells: 1 });
      }
      if (url.includes("includeGridData=true")) {
        return json({
          sheets: [
            {
              data: [
                {
                  startRow: 1,
                  rowData: [
                    {
                      values: [
                        {
                          effectiveFormat: {
                            backgroundColorStyle: {
                              rgbColor: { red: 1, green: 0, blue: 0 },
                            },
                          },
                        },
                      ],
                    },
                    { values: [{}] },
                    { values: [{}] },
                  ],
                },
              ],
            },
          ],
        });
      }
      if (url.includes("/values/") && url.includes("E4")) {
        return json({ values: [] });
      }
      if (url.includes("/values/")) {
        return json({
          values: [
            [
              "Category",
              "Working Title",
              "Narration Draft",
              "ID",
              "LangGraph ID",
            ],
            ["History", "Red row", "Skip me", "1", ""],
            ["Science", "Used row", "Skip me too", "2", "thread-old"],
            ["Space", "A hidden moon", "Here is the narration", "3", ""],
          ],
        });
      }
      return json({
        sheets: [{ properties: { sheetId: 109, title: "Ideas" } }],
      });
    });

    const source = new GoogleSheetsStorySource({
      spreadsheetId: "sheet-1",
      sheetGid: 109,
      headerRow: 1,
      fetchImpl,
      tokenProvider: { getAccessToken: async () => "token" },
      random: () => 0,
    });

    await expect(source.reserveRandom("thread-new")).resolves.toEqual({
      rowNumber: 4,
      category: "Space",
      workingTitle: "A hidden moon",
      narrationDraft: "Here is the narration",
    });
    expect(updates).toEqual([
      {
        range: "'Ideas'!E4",
        majorDimension: "ROWS",
        values: [["thread-new"]],
      },
    ]);
  });

  it("fails clearly when a required header is missing", async () => {
    const fetchImpl = jest.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/values/")) {
        return json({ values: [["Category", "Working Title", "ID"]] });
      }
      return json({ sheets: [{ properties: { sheetId: 1, title: "Ideas" } }] });
    });
    const source = new GoogleSheetsStorySource({
      spreadsheetId: "sheet-1",
      sheetGid: 1,
      headerRow: 1,
      fetchImpl,
      tokenProvider: { getAccessToken: async () => "token" },
    });

    await expect(source.reserveRandom("thread-1")).rejects.toThrow(
      "Narration Draft",
    );
  });

  it("adds the YouTube Edit URL column and records the URL by LangGraph ID", async () => {
    const updates: Array<{ range: string; values: string[][] }> = [];
    const fetchImpl = jest.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          range: string;
          values: string[][];
        };
        updates.push(body);
        return json({ updatedCells: 1 });
      }
      if (url.includes("/values/")) {
        return json({
          values: [
            [
              "Category",
              "Working Title",
              "Narration Draft",
              "ID",
              "LangGraph ID",
            ],
            ["History", "Story", "Narration", "1", "thread-1"],
          ],
        });
      }
      return json({ sheets: [{ properties: { sheetId: 1, title: "Ideas" } }] });
    });
    const source = new GoogleSheetsStorySource({
      spreadsheetId: "sheet-1",
      sheetGid: 1,
      headerRow: 1,
      fetchImpl,
      tokenProvider: { getAccessToken: async () => "token" },
    });

    await source.recordYoutubeEditUrl(
      "thread-1",
      "https://studio.youtube.com/video/video-1/edit",
    );

    expect(updates).toEqual([
      {
        range: "'Ideas'!F1",
        majorDimension: "ROWS",
        values: [["YouTube Edit URL"]],
      },
      {
        range: "'Ideas'!F2",
        majorDimension: "ROWS",
        values: [["https://studio.youtube.com/video/video-1/edit"]],
      },
    ]);
  });
});
