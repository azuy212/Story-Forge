import { describe, it, expect } from "@jest/globals";
import {
  pickPendingRow,
  nextPublishSlot,
  EXPECTED_HEADERS,
} from "../src/integrations/google-sheets/sheets-format.mjs";

function plannedRow(overrides: Partial<Record<number, string>> = {}): string[] {
  const row = Array(EXPECTED_HEADERS.length).fill("");
  row[0] = "abc123";
  row[1] = "Geography";
  row[2] = "Unrecognized Countries";
  row[4] = "planned";
  for (const [i, v] of Object.entries(overrides)) {
    row[Number(i)] = v;
  }
  return row;
}

describe("pickPendingRow", () => {
  it("picks the first valid planned row after the header", () => {
    const rows = [EXPECTED_HEADERS, plannedRow(), plannedRow({ 0: "def456" })];
    const picked = pickPendingRow(rows);
    expect(picked).toEqual({
      videoId: "abc123",
      category: "Geography",
      topic: "Unrecognized Countries",
      rowIndex: 2,
    });
  });

  it("skips rows that are not planned", () => {
    const rows = [
      EXPECTED_HEADERS,
      plannedRow({ 4: "published" }),
      plannedRow({ 0: "def456" }),
    ];
    const picked = pickPendingRow(rows);
    expect(picked?.videoId).toBe("def456");
  });

  it("skips planned rows missing required fields and logs the reason", () => {
    const logs: string[] = [];
    const rows = [
      EXPECTED_HEADERS,
      plannedRow({ 2: "" }),
      plannedRow({ 0: "" }),
      plannedRow({ 0: "ok123" }),
    ];
    const picked = pickPendingRow(rows, (m) => logs.push(m));
    expect(picked?.videoId).toBe("ok123");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("missing Topic");
    expect(logs[1]).toContain("missing Video ID");
  });

  it("returns null when no planned row is valid", () => {
    const rows = [EXPECTED_HEADERS, plannedRow({ 4: "published" })];
    expect(pickPendingRow(rows)).toBeNull();
  });

  it("returns null for an empty sheet", () => {
    expect(pickPendingRow([])).toBeNull();
  });
});

describe("nextPublishSlot", () => {
  const fixedNow = new Date("2026-08-20T10:00:00");

  it("returns the earliest future slot the same day", () => {
    expect(nextPublishSlot([], fixedNow)).toBe(
      new Date("2026-08-20T12:00:00").toISOString(),
    );
  });

  it("moves to 20:00 after 12:00 has passed", () => {
    const now = new Date("2026-08-20T15:00:00");
    expect(nextPublishSlot([], now)).toBe(
      new Date("2026-08-20T20:00:00").toISOString(),
    );
  });

  it("skips occupied slots", () => {
    const now = new Date("2026-08-20T10:00:00");
    const occupied = [new Date("2026-08-20T12:00:00").toISOString()];
    expect(nextPublishSlot(occupied, now)).toBe(
      new Date("2026-08-20T20:00:00").toISOString(),
    );
  });

  it("moves to the next day after both slots are gone", () => {
    const now = new Date("2026-08-20T21:00:00");
    expect(nextPublishSlot([], now)).toBe(
      new Date("2026-08-21T12:00:00").toISOString(),
    );
  });

  it("skips consecutive occupied days", () => {
    const now = new Date("2026-08-20T10:00:00");
    const occupied = [
      new Date("2026-08-20T12:00:00").toISOString(),
      new Date("2026-08-20T20:00:00").toISOString(),
      new Date("2026-08-21T12:00:00").toISOString(),
      new Date("2026-08-21T20:00:00").toISOString(),
      new Date("2026-08-22T12:00:00").toISOString(),
      new Date("2026-08-22T20:00:00").toISOString(),
      new Date("2026-08-23T12:00:00").toISOString(),
      new Date("2026-08-23T20:00:00").toISOString(),
      new Date("2026-08-24T12:00:00").toISOString(),
      new Date("2026-08-24T20:00:00").toISOString(),
    ];
    expect(nextPublishSlot(occupied, now)).toBe(
      new Date("2026-08-25T12:00:00").toISOString(),
    );
  });
});
