import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideRun,
  findRunByTopic,
  runLauncher,
  readSheetRows,
} from "../scripts/run-next.mjs";
import { getAssistantId, resumeRun } from "../scripts/resume.mjs";
import { EXPECTED_HEADERS } from "../src/integrations/google-sheets/sheets-format.mjs";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "run-next-test-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

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

function addRun(ns: string, meta: Record<string, unknown>) {
  mkdirSync(join(runsDir, ns), { recursive: true });
  writeFileSync(join(runsDir, ns, "run.json"), JSON.stringify(meta));
}

const FIXED_NOW = new Date("2026-08-20T10:00:00");

describe("decideRun", () => {
  it("resumes an existing run for a topic and preserves its projectId", () => {
    addRun("geo-run-1", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "legacy-1",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      FIXED_NOW,
    );
    expect(decision).toMatchObject({
      action: "resume",
      ns: "geo-run-1",
      pillar: "Geography",
      topic: "Unrecognized Countries",
      projectId: "legacy-1",
    });
  });

  it("re-seeds the next free slot on resume like a new run", () => {
    addRun("geo-run-3", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "legacy-1",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      FIXED_NOW,
    );
    expect(decision.action).toBe("resume");
    expect(decision.youtubePublishAt).toBe(
      new Date("2026-08-20T12:00:00").toISOString(),
    );
  });

  it("still resumes without a slot when every slot is occupied", () => {
    addRun("geo-run-4", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "legacy-1",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const scheduled = new Date("2026-08-20T10:00:00");
    const rows = [EXPECTED_HEADERS, plannedRow()];
    for (let day = 0; day < 30; day++) {
      for (const hour of [12, 20]) {
        const slot = new Date(scheduled);
        slot.setDate(slot.getDate() + day);
        slot.setHours(hour, 0, 0, 0);
        if (slot.getTime() <= FIXED_NOW.getTime()) continue;
        rows.push([
          `other-${day}-${hour}`,
          "Geography",
          "Other",
          "Other",
          "scheduled",
          "yt-x",
          "https://youtu.be/x",
          "private",
          slot.toISOString(),
          "",
          "",
        ]);
      }
    }
    const decision: any = decideRun(runsDir, rows, FIXED_NOW);
    expect(decision.action).toBe("resume");
    expect(decision.youtubePublishAt).toBeUndefined();
  });

  it("falls back to the backlog row video id for legacy runs without projectId", () => {
    addRun("geo-run-2", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow({ 0: "row-id-9" })],
      FIXED_NOW,
    );
    expect(decision.action).toBe("resume");
    expect(decision.projectId).toBe("row-id-9");
  });

  it("creates a new run with the next slot when the topic is new", () => {
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      FIXED_NOW,
    );
    expect(decision).toMatchObject({
      action: "create",
      pillar: "Geography",
      topic: "Unrecognized Countries",
      projectId: "abc123",
      youtubePublishAt: new Date("2026-08-20T12:00:00").toISOString(),
    });
    expect(decision.ns).toMatch(/^unrecognized-countries-/);
  });

  it("returns no-pending-row when nothing is planned", () => {
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow({ 4: "published" })],
      FIXED_NOW,
    );
    expect(decision).toEqual({ action: "none", reason: "no-pending-row" });
  });

  it("skips a malformed planned row and creates from the next valid one", () => {
    const rows = [
      EXPECTED_HEADERS,
      plannedRow({ 2: "" }),
      plannedRow({ 0: "ok-1" }),
    ];
    const decision: any = decideRun(runsDir, rows, FIXED_NOW);
    expect(decision).toMatchObject({ action: "create", projectId: "ok-1" });
  });

  it("skips occupied slots when picking the publish time", () => {
    const rows = [
      EXPECTED_HEADERS,
      plannedRow(),
      // A scheduled video occupies today's 12:00 slot.
      [
        "other-1",
        "Geography",
        "Other",
        "Other",
        "scheduled",
        "yt-1",
        "https://youtu.be/yt-1",
        "private",
        new Date("2026-08-20T12:00:00").toISOString(),
        "",
        "",
      ],
    ];
    const decision: any = decideRun(runsDir, rows, FIXED_NOW);
    expect(decision.action).toBe("create");
    expect(decision.youtubePublishAt).toBe(
      new Date("2026-08-20T20:00:00").toISOString(),
    );
  });
});

describe("findRunByTopic", () => {
  it("returns null when no run matches", () => {
    expect(findRunByTopic(runsDir, "Missing Topic")).toBeNull();
  });

  it("picks the newest run when several share a topic", () => {
    addRun("old", {
      topic: "Topic",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    addRun("new", {
      topic: "Topic",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(findRunByTopic(runsDir, "Topic")?.ns).toBe("new");
  });
});

const launcherEnv = () => ({
  YOUTUBE_CLIENT_ID: "cid",
  YOUTUBE_CLIENT_SECRET: "sec",
  YOUTUBE_REFRESH_TOKEN: "ref",
  GOOGLE_SHEETS_SPREADSHEET_ID: "ssid",
});

describe("runLauncher", () => {
  let errorLines: string[];

  beforeEach(() => {
    errorLines = [];
    jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLines.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function baseDeps() {
    return {
      env: launcherEnv(),
      runsDir,
      readRows: jest
        .fn<typeof readSheetRows>()
        .mockResolvedValue([EXPECTED_HEADERS, plannedRow()]),
      getAssistantId: jest
        .fn<typeof getAssistantId>()
        .mockResolvedValue("ast-1"),
      resumeRun: jest
        .fn<typeof resumeRun>()
        .mockResolvedValue({ threadId: "t-1", lastEvent: null }),
    };
  }

  it("dispatches a new run, waits for its terminal state, and resolves (create path)", async () => {
    const deps = baseDeps();
    await expect(runLauncher(deps)).resolves.toBeUndefined();

    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
    const [ns, input, options]: any[] = deps.resumeRun.mock.calls[0];
    expect(ns).toMatch(/^unrecognized-countries-/);
    expect(input).toEqual({
      pillar: "Geography",
      topic: "Unrecognized Countries",
    });
    expect(options).toEqual({
      assistantId: "ast-1",
      projectId: "abc123",
      // Exact slot math is covered by the decideRun tests; here it just has
      // to be a concrete seeded slot.
      youtubePublishAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      ),
    });
  });

  it("resumes the persisted run and preserves its projectId (resume path)", async () => {
    addRun("geo-run-9", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "legacy-1",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const deps = baseDeps();
    await expect(runLauncher(deps)).resolves.toBeUndefined();

    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
    const [ns, input, options]: any[] = deps.resumeRun.mock.calls[0];
    expect(ns).toBe("geo-run-9");
    expect(input).toEqual({
      pillar: "Geography",
      topic: "Unrecognized Countries",
    });
    expect(options.projectId).toBe("legacy-1");
    expect(options.youtubePublishAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("logs a recoverable pipeline failure with ns/topic and resolves normally (exit 0)", async () => {
    const deps = baseDeps();
    deps.resumeRun = jest
      .fn<typeof resumeRun>()
      .mockRejectedValue(new Error("graph exploded"));
    await expect(runLauncher(deps)).resolves.toBeUndefined();

    expect(errorLines).toHaveLength(1);
    const logged = errorLines[0];
    expect(logged).toContain("pipeline run failed");
    expect(logged).toContain('"Unrecognized Countries"');
    expect(logged).toContain("unrecognized-countries-");
    expect(logged).toContain("graph exploded");
  });

  it("fails fatally when reading the sheet fails (auth/read failure) and never dispatches", async () => {
    const deps = baseDeps();
    deps.readRows = jest
      .fn<typeof readSheetRows>()
      .mockRejectedValue(new Error("invalid_grant"));
    await expect(runLauncher(deps)).rejects.toThrow(
      /reading sheet failed.*invalid_grant/s,
    );
    expect(deps.resumeRun).not.toHaveBeenCalled();
  });

  it("fails fatally on invalid sheet headers", async () => {
    const deps = baseDeps();
    deps.readRows = jest
      .fn<typeof readSheetRows>()
      .mockResolvedValue([["Wrong"], plannedRow()]);
    await expect(runLauncher(deps)).rejects.toThrow(
      "Google Sheets header mismatch",
    );
  });

  it("fails fatally when credentials are missing", async () => {
    await expect(runLauncher({ ...baseDeps(), env: {} })).rejects.toThrow(
      "missing YOUTUBE_CLIENT_ID",
    );
  });

  it("fails fatally when the assistant cannot be obtained and never dispatches the run", async () => {
    const deps = baseDeps();
    deps.getAssistantId = jest
      .fn<typeof getAssistantId>()
      .mockRejectedValue(new Error("No 'agent' assistant found"));
    await expect(runLauncher(deps)).rejects.toThrow("getAssistantId failed");
    expect(deps.resumeRun).not.toHaveBeenCalled();
  });
});
