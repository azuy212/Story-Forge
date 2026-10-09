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
  isRunAlreadyPublished,
  parseSseEvent,
  PRODUCER_NODES,
  reemitSseEventToSink,
  setActiveSink,
  __resetReemitStateForTest,
  runLauncher,
  validateProfile,
  readSheetRows,
  addInjectArtifact,
} from "../scripts/run-next.mjs";
import { getAssistantId, resumeRun } from "../scripts/resume.mjs";
import { closeAllRunLogSinks } from "../dist/utils/run-log.js";
import { logger } from "../dist/utils/logger.js";
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

function addPublishedRun(ns: string, meta: Record<string, unknown>) {
  addRun(ns, meta);
  writeFileSync(
    join(runsDir, ns, "manifest.json"),
    JSON.stringify({
      publish: {
        latest: "v1",
        versions: [{ version: 1, status: "complete" }],
      },
    }),
  );
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
      "short",
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
      "short",
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
    const decision: any = decideRun(runsDir, rows, "short", FIXED_NOW);
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
      "short",
      FIXED_NOW,
    );
    expect(decision.action).toBe("resume");
    expect(decision.projectId).toBe("row-id-9");
  });

  it("creates a new run with the next slot when the topic is new", () => {
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      "short",
      FIXED_NOW,
    );
    expect(decision).toMatchObject({
      action: "create",
      pillar: "Geography",
      topic: "Unrecognized Countries",
      projectId: "abc123",
      youtubePublishAt: new Date("2026-08-20T12:00:00").toISOString(),
    });
    expect(decision.ns).toMatch(/^\d{8}-\d{6}\.\d{3}-unrecognized-countries$/);
  });

  it("returns no-pending-row when nothing is planned", () => {
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow({ 4: "published" })],
      "short",
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
    const decision: any = decideRun(runsDir, rows, "short", FIXED_NOW);
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
    const decision: any = decideRun(runsDir, rows, "short", FIXED_NOW);
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

  it("never returns a run from another profile", () => {
    addRun("short-run", {
      topic: "Topic",
      videoProfile: "short",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    addRun("long-run", {
      topic: "Topic",
      videoProfile: "long",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    expect(findRunByTopic(runsDir, "Topic", "long")?.ns).toBe("long-run");
    expect(findRunByTopic(runsDir, "Topic", "short")?.ns).toBe("short-run");
  });

  it("still matches legacy runs with no recorded profile", () => {
    addRun("legacy", {
      topic: "Topic",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    expect(findRunByTopic(runsDir, "Topic", "long")?.ns).toBe("legacy");
  });
});

const launcherEnv = () => ({
  YOUTUBE_CLIENT_ID: "cid",
  YOUTUBE_CLIENT_SECRET: "sec",
  YOUTUBE_REFRESH_TOKEN: "ref",
  GOOGLE_SHEETS_SPREADSHEET_ID: "ssid",
});

describe("runLauncher", () => {
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
    jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
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
    expect(ns).toMatch(/^\d{8}-\d{6}\.\d{3}-unrecognized-countries$/);
    expect(input).toEqual({
      pillar: "Geography",
      topic: "Unrecognized Countries",
      videoProfile: "short",
    });
    expect(options).toMatchObject({
      assistantId: "ast-1",
      projectId: "abc123",
      youtubePublishAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      ),
    });
    expect(typeof options.onEvent).toBe("function");
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
      videoProfile: "short",
    });
    expect(options.projectId).toBe("legacy-1");
    expect(options.youtubePublishAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("skips an already-published backlog row, warns, and dispatches the next one", async () => {
    addPublishedRun("done-run", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "abc123",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const deps = baseDeps();
    deps.readRows = jest
      .fn<typeof readSheetRows>()
      .mockResolvedValue([
        EXPECTED_HEADERS,
        plannedRow(),
        plannedRow({ 0: "def456", 2: "The Mary Celeste" }),
      ]);
    await expect(runLauncher(deps)).resolves.toBeUndefined();

    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
    const [ns, input]: any[] = deps.resumeRun.mock.calls[0];
    expect(ns).not.toBe("done-run");
    expect(input.topic).toBe("The Mary Celeste");
    const warn = (
      logger as unknown as {
        _captured: Array<{ level: string; message: string }>;
      }
    )._captured.find(
      (c) => c.level === "warn" && c.message.includes("done-run"),
    );
    expect(warn?.message).toContain("already published");
  });

  it("does nothing when every planned row already published", async () => {
    addPublishedRun("done-run", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const deps = baseDeps();
    await expect(runLauncher(deps)).resolves.toBeUndefined();
    expect(deps.resumeRun).not.toHaveBeenCalled();
  });

  it("resets QA retries for the last step before resuming when the flag is set", async () => {
    addRun("geo-run-reset", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "legacy-1",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const deps = baseDeps();
    const resetQaResume = jest.fn(() => ({
      reason: null,
      frontier: "scriptQA",
      resetTypes: ["script", "scriptQA"],
      dryRun: false,
      deleted: { script: 3, scriptQA: 5 },
    }));
    await expect(
      runLauncher({ ...deps, resetQaRetries: true, resetQaResume }),
    ).resolves.toBeUndefined();

    expect(resetQaResume).toHaveBeenCalledTimes(1);
    expect(resetQaResume).toHaveBeenCalledWith(runsDir, "geo-run-reset");
    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
    const captured = (
      logger as unknown as {
        _captured: Array<{ level: string; message: string }>;
      }
    )._captured;
    const logged = captured.filter(
      (c) => c.level === "info" && c.message.includes("QA retry reset"),
    );
    expect(logged.at(-1)?.message).toContain('cleared frontier "scriptQA"');
  });

  it("never resets QA retries on the create path even with the flag", async () => {
    const deps = baseDeps();
    const resetQaResume = jest.fn(() => ({
      reason: null,
      frontier: "scriptQA",
      resetTypes: [],
      dryRun: false,
      deleted: {},
    }));
    await expect(
      runLauncher({ ...deps, resetQaRetries: true, resetQaResume }),
    ).resolves.toBeUndefined();

    expect(resetQaResume).not.toHaveBeenCalled();
    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
  });

  it("does not reset QA retries by default", async () => {
    addRun("geo-run-default", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "legacy-1",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const deps = baseDeps();
    const resetQaResume = jest.fn();
    await expect(
      runLauncher({ ...deps, resetQaResume }),
    ).resolves.toBeUndefined();

    expect(resetQaResume).not.toHaveBeenCalled();
    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
  });

  it("logs a recoverable pipeline failure with ns/topic and resolves normally (exit 0)", async () => {
    const deps = baseDeps();
    deps.resumeRun = jest
      .fn<typeof resumeRun>()
      .mockRejectedValue(new Error("graph exploded"));
    await expect(runLauncher(deps)).resolves.toBeUndefined();

    // The logger outputs JSON to console.log now
    const logged = logLines.find((l) => l.includes("pipeline run failed"));
    expect(logged).toBeDefined();
    expect(logged).toContain("Unrecognized Countries");
    expect(logged).toMatch(/\d{8}-\d{6}\.\d{3}-unrecognized-countries/);
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

  it("reads from Long Videos sheet when profile is long", async () => {
    const deps = baseDeps();
    deps.env = {
      ...launcherEnv(),
      GOOGLE_SHEETS_SHEET_NAME_LONG: "Long Videos",
    };
    await runLauncher({ ...deps, profile: "long" });
    expect(deps.readRows).toHaveBeenCalledWith(
      expect.anything(),
      "ssid",
      "Long Videos",
    );
  });

  it("reads from Sheet1 sheet when profile is short", async () => {
    const deps = baseDeps();
    await runLauncher({ ...deps, profile: "short" });
    expect(deps.readRows).toHaveBeenCalledWith(
      expect.anything(),
      "ssid",
      "Sheet1",
    );
  });

  it("rejects invalid profile at the boundary", async () => {
    const deps = baseDeps();
    await expect(runLauncher({ ...deps, profile: "invalid" })).rejects.toThrow(
      "invalid profile 'invalid'",
    );
  });

  it("forwards manualArtifacts and manualArtifactProfile to resumeRun (create path)", async () => {
    const deps = baseDeps();
    const manualArtifacts = { promptQA: "/abs/prompt-qa.json" };
    await expect(
      runLauncher({ ...deps, manualArtifacts }),
    ).resolves.toBeUndefined();

    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
    const options: any = deps.resumeRun.mock.calls[0][2];
    expect(options.manualArtifacts).toEqual(manualArtifacts);
    expect(options.manualArtifactProfile).toBe("short");
  });

  it("uses the run's persisted profile for manualArtifactProfile on resume", async () => {
    addRun("geo-run-long", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "legacy-1",
      videoProfile: "long",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const deps = baseDeps();
    await expect(
      runLauncher({
        ...deps,
        profile: "long",
        manualArtifacts: { scriptQA: "/abs/script-qa.json" },
      }),
    ).resolves.toBeUndefined();

    expect(deps.resumeRun).toHaveBeenCalledTimes(1);
    const options: any = deps.resumeRun.mock.calls[0][2];
    expect(options.manualArtifacts).toEqual({
      scriptQA: "/abs/script-qa.json",
    });
    expect(options.manualArtifactProfile).toBe("long");
  });

  it("omits manualArtifacts/manualArtifactProfile when none are configured", async () => {
    const deps = baseDeps();
    await expect(runLauncher(deps)).resolves.toBeUndefined();

    const options: any = deps.resumeRun.mock.calls[0][2];
    expect(options.manualArtifacts).toBeUndefined();
    expect(options.manualArtifactProfile).toBeUndefined();
  });
});

describe("addInjectArtifact", () => {
  it("parses a single <type>=<path> value", () => {
    expect(addInjectArtifact(undefined, "promptQA=./prompt-qa.json")).toEqual({
      promptQA: "./prompt-qa.json",
    });
  });

  it("collects repeated flags for the same type into an array", () => {
    let map = addInjectArtifact(undefined, "prompts=./a/");
    map = addInjectArtifact(map, "prompts=./b/");
    expect(map).toEqual({ prompts: ["./a/", "./b/"] });
  });

  it("allows = inside the path portion", () => {
    expect(addInjectArtifact(undefined, "promptQA=./odd=name.json")).toEqual({
      promptQA: "./odd=name.json",
    });
  });

  it("rejects malformed values", () => {
    expect(() => addInjectArtifact(undefined, "no-equals")).toThrow(
      "--inject-artifact requires <type>=<path>",
    );
    expect(() => addInjectArtifact(undefined, "=path.json")).toThrow(
      "--inject-artifact requires <type>=<path>",
    );
    expect(() => addInjectArtifact(undefined, "type=")).toThrow(
      "--inject-artifact requires <type>=<path>",
    );
  });
});

describe("validateProfile", () => {
  it("accepts short", () => {
    expect(() => validateProfile("short")).not.toThrow();
  });

  it("accepts long", () => {
    expect(() => validateProfile("long")).not.toThrow();
  });

  it("rejects invalid values", () => {
    expect(() => validateProfile("medium")).toThrow("invalid profile 'medium'");
    expect(() => validateProfile("")).toThrow("invalid profile ''");
  });
});

describe("decideRun profile routing", () => {
  it("long profile picks a Tuesday/Friday slot", () => {
    // Wednesday 2026-08-19 10:00 → next long slot is Friday 2026-08-21 20:00
    const now = new Date("2026-08-19T10:00:00");
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      "long",
      now,
    );
    expect(decision.youtubePublishAt).toBe(
      new Date("2026-08-21T20:00:00").toISOString(),
    );
  });

  it("short profile picks a daily 12:00 or 20:00 slot", () => {
    // Wednesday 2026-08-19 10:00 → next short slot is Wednesday 2026-08-19 12:00
    const now = new Date("2026-08-19T10:00:00");
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      "short",
      now,
    );
    expect(decision.youtubePublishAt).toBe(
      new Date("2026-08-19T12:00:00").toISOString(),
    );
  });

  it("does not resume a run whose persisted profile differs", () => {
    addRun("geo-run-profile", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      videoProfile: "long",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      "short",
      FIXED_NOW,
    );
    // The same topic can be planned in both backlog tabs under different
    // Video IDs; a short launch must never hijack the long run.
    expect(decision).toMatchObject({
      action: "create",
      topic: "Unrecognized Countries",
      profile: "short",
      projectId: "abc123",
    });
  });

  it("resumes a same-profile run and keeps its persisted profile", () => {
    addRun("geo-run-same-profile", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      videoProfile: "long",
      projectId: "legacy-1",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      "long",
      FIXED_NOW,
    );
    expect(decision).toMatchObject({
      action: "resume",
      ns: "geo-run-same-profile",
      profile: "long",
      projectId: "legacy-1",
    });
  });

  it("legacy run without videoProfile honors the requested profile", () => {
    addRun("geo-run-legacy", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const decision: any = decideRun(
      runsDir,
      [EXPECTED_HEADERS, plannedRow()],
      "long",
      FIXED_NOW,
    );
    expect(decision.action).toBe("resume");
    expect(decision.profile).toBe("long");
  });
});

describe("isRunAlreadyPublished", () => {
  it("is false for a run with no manifest", () => {
    addRun("no-manifest", { topic: "Topic" });
    expect(isRunAlreadyPublished(runsDir, "no-manifest")).toBe(false);
  });

  it("is false when the latest publish artifact is not complete", () => {
    addRun("pending-publish", { topic: "Topic" });
    writeFileSync(
      join(runsDir, "pending-publish", "manifest.json"),
      JSON.stringify({
        publish: {
          latest: "v2",
          versions: [
            { version: 1, status: "complete" },
            { version: 2, status: "pending" },
          ],
        },
      }),
    );
    expect(isRunAlreadyPublished(runsDir, "pending-publish")).toBe(false);
  });

  it("is true once the latest publish artifact is complete", () => {
    addPublishedRun("published", { topic: "Topic" });
    expect(isRunAlreadyPublished(runsDir, "published")).toBe(true);
  });

  it("is false for an unreadable manifest", () => {
    addRun("corrupt", { topic: "Topic" });
    writeFileSync(join(runsDir, "corrupt", "manifest.json"), "{not json");
    expect(isRunAlreadyPublished(runsDir, "corrupt")).toBe(false);
  });
});

describe("decideRun backlog advance", () => {
  it("skips a planned row whose run already published and takes the next one", () => {
    addPublishedRun("titanic-run", {
      topic: "Unrecognized Countries",
      pillar: "Geography",
      projectId: "abc123",
      videoProfile: "short",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const decision: any = decideRun(
      runsDir,
      [
        EXPECTED_HEADERS,
        plannedRow(),
        plannedRow({ 0: "def456", 2: "The Mary Celeste" }),
      ],
      "short",
      FIXED_NOW,
    );
    expect(decision).toMatchObject({
      action: "create",
      topic: "The Mary Celeste",
      projectId: "def456",
    });
    expect(decision.skipped).toEqual([
      { row: 2, topic: "Unrecognized Countries", ns: "titanic-run" },
    ]);
  });

  it("reports every skipped row when all planned rows already published", () => {
    addPublishedRun("done-1", {
      topic: "Unrecognized Countries",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    addPublishedRun("done-2", {
      topic: "The Mary Celeste",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    const decision: any = decideRun(
      runsDir,
      [
        EXPECTED_HEADERS,
        plannedRow(),
        plannedRow({ 0: "def456", 2: "The Mary Celeste" }),
      ],
      "short",
      FIXED_NOW,
    );
    expect(decision).toMatchObject({
      action: "none",
      reason: "all-planned-rows-published",
    });
    expect(decision.skipped.map((s: any) => s.ns)).toEqual([
      "done-1",
      "done-2",
    ]);
  });
});

describe("parseSseEvent", () => {
  it("returns null for non-start/end frames (metadata/values)", () => {
    expect(
      parseSseEvent({ event: "metadata", run_id: "r1", attempt: 1 }),
    ).toBeNull();
    expect(parseSseEvent({ event: "values", data: {} })).toBeNull();
    expect(parseSseEvent(null)).toBeNull();
  });

  it("returns null for on_chain_* without a langgraph_node metadata", () => {
    expect(
      parseSseEvent({ event: "on_chain_start", name: "RunnableSequence" }),
    ).toBeNull();
  });

  it("maps on_chain_start to running", () => {
    expect(
      parseSseEvent({
        event: "on_chain_start",
        name: "ResearchAgent",
        metadata: { langgraph_node: "ResearchAgent" },
      }),
    ).toEqual({ name: "ResearchAgent", status: "running" });
  });

  it("maps on_chain_end with no error to complete", () => {
    expect(
      parseSseEvent({
        event: "on_chain_end",
        name: "ResearchAgent",
        metadata: { langgraph_node: "ResearchAgent" },
        data: { output: { research: { summary: "..." } } },
      }),
    ).toEqual({ name: "ResearchAgent", status: "complete" });
  });

  it("maps on_chain_end with status:error to failed", () => {
    expect(
      parseSseEvent({
        event: "on_chain_end",
        name: "ScriptWriter",
        status: "error",
        metadata: { langgraph_node: "ScriptWriter" },
      }),
    ).toEqual({ name: "ScriptWriter", status: "failed" });
  });

  it("ignores on_chain_stream and other intermediate events", () => {
    expect(
      parseSseEvent({
        event: "on_chain_stream",
        name: "ResearchAgent",
        metadata: { langgraph_node: "ResearchAgent" },
      }),
    ).toBeNull();
  });

  it("PRODUCER_NODES covers every agent node that drives the pipeline spine", () => {
    expect(PRODUCER_NODES).toContain("ResearchAgent");
    expect(PRODUCER_NODES).toContain("ScriptPlanner");
    expect(PRODUCER_NODES).toContain("ScriptWriter");
    expect(PRODUCER_NODES).toContain("VisualDirector");
    expect(PRODUCER_NODES).toContain("AssetStrategy");
    expect(PRODUCER_NODES).toContain("ImagePromptGenerator");
    expect(PRODUCER_NODES).toContain("AssetGenerator");
    expect(PRODUCER_NODES).toContain("ImagePromptRepair");
    expect(PRODUCER_NODES).toContain("VideoComposer");
    expect(PRODUCER_NODES).toContain("MetadataGenerator");
    expect(PRODUCER_NODES).toContain("ThumbnailGenerator");
    expect(PRODUCER_NODES).toContain("Publisher");
    expect(PRODUCER_NODES).not.toContain("ResearchQA");
    expect(PRODUCER_NODES).not.toContain("ScriptQA");
    expect(PRODUCER_NODES).not.toContain("PromptQA");
    expect(PRODUCER_NODES).not.toContain("Finalize");
    expect(PRODUCER_NODES).not.toContain("StoryPlanner");
  });
});

describe("runLauncher wires onEvent into resumeRun", () => {
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
    jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("forwards an onEvent callback that the SSE consumer can call to tick the bar", async () => {
    const resumeRunMock = jest
      .fn<typeof resumeRun>()
      .mockImplementation(async (ns, _input, opts) => {
        expect(typeof opts?.onEvent).toBe("function");
        opts?.onEvent?.({
          event: "on_chain_start",
          metadata: { langgraph_node: "ResearchAgent" },
        });
        return { threadId: "t-1", lastEvent: null };
      });
    const deps = {
      env: {
        YOUTUBE_CLIENT_ID: "cid",
        YOUTUBE_CLIENT_SECRET: "sec",
        YOUTUBE_REFRESH_TOKEN: "ref",
        GOOGLE_SHEETS_SPREADSHEET_ID: "ssid",
      },
      runsDir,
      readRows: jest
        .fn<typeof readSheetRows>()
        .mockResolvedValue([EXPECTED_HEADERS, plannedRow()]),
      getAssistantId: jest
        .fn<typeof getAssistantId>()
        .mockResolvedValue("ast-1"),
      resumeRun: resumeRunMock,
    };
    await runLauncher(deps);

    expect(resumeRunMock).toHaveBeenCalledTimes(1);
    const opts = resumeRunMock.mock.calls[0][2] as {
      onEvent?: (e: unknown) => void;
    };
    expect(opts.onEvent).toBeDefined();
  });
});

describe("reemitSseEventToSink", () => {
  interface CapturedEvent {
    event: string;
    [key: string]: unknown;
  }

  function makeSink(): {
    sink: {
      runId: string;
      filePath: string;
      events: CapturedEvent[];
      appendLine: (e: CapturedEvent) => Promise<void>;
      flush: () => Promise<void>;
      close: () => Promise<void>;
    };
    events: CapturedEvent[];
  } {
    const events: CapturedEvent[] = [];
    return {
      events,
      sink: {
        runId: "sse-test",
        filePath: "/tmp/never",
        events,
        appendLine: (e) => {
          events.push(e);
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
        close: () => Promise.resolve(),
      },
    };
  }

  // Reuse one sink per test so writes via reemitSseEventToSink land in the
  // events array the test body checks.
  let sharedEvents: CapturedEvent[];

  beforeEach(() => {
    __resetReemitStateForTest();
    const { sink, events } = makeSink();
    setActiveSink(sink);
    sharedEvents = events;
  });

  afterEach(() => {
    setActiveSink(null);
    closeAllRunLogSinks();
  });

  it("emits node_start then node_end for a matching chain pair", () => {
    reemitSseEventToSink({
      event: "on_chain_start",
      metadata: { langgraph_node: "ResearchAgent" },
    });
    reemitSseEventToSink({
      event: "on_chain_end",
      metadata: { langgraph_node: "ResearchAgent" },
      status: "success",
      data: {
        output: {
          diagnostics: {
            errors: [],
            telemetry: {
              ResearchAgent: { result: { promptTokens: 10, totalTokens: 20 } },
            },
          },
        },
      },
    });

    const kinds = sharedEvents.map((e) => e.event);
    expect(kinds).toEqual(["node_start", "node_end"]);
    const end = sharedEvents[1] as Record<string, unknown> & {
      tokenSummary?: unknown;
    };
    expect(end.node).toBe("ResearchAgent");
    expect(typeof end.durationMs).toBe("number");
    expect(end.tokenSummary).toEqual({
      promptTokens: 10,
      completionTokens: undefined,
      totalTokens: 20,
      costUsd: undefined,
      retries: undefined,
    });
  });

  it("emits node_failed when status is error", () => {
    reemitSseEventToSink({
      event: "on_chain_start",
      metadata: { langgraph_node: "ScriptWriter" },
    });
    reemitSseEventToSink({
      event: "on_chain_end",
      metadata: { langgraph_node: "ScriptWriter" },
      status: "error",
      data: {
        output: {
          diagnostics: {
            errors: ["ScriptWriter: model failure"],
          },
        },
      },
    });

    const kinds = sharedEvents.map((e) => e.event);
    expect(kinds).toEqual(["node_start", "node_failed"]);
    const failed = sharedEvents[1] as Record<string, unknown>;
    expect(failed.node).toBe("ScriptWriter");
    expect(failed.diagnosticsErrors).toEqual(["ScriptWriter: model failure"]);
  });

  it("ignores root graph chain events (no langgraph_node)", () => {
    reemitSseEventToSink({
      event: "on_chain_start",
      metadata: { langgraph_plan: "developer" },
      name: "YouTubeShortsPipeline",
    });
    reemitSseEventToSink({
      event: "on_chain_end",
      metadata: { langgraph_plan: "developer" },
      name: "YouTubeShortsPipeline",
      status: "success",
    });

    expect(sharedEvents).toEqual([]);
  });

  it("deduplicates node_start when the same node fires twice (QA retry)", () => {
    // The langgraph dev server can emit on_chain_start for the same node
    // multiple times during a run (root chain wrapping, sub-chain). We
    // dedupe by node name so each node gets exactly one node_start per
    // attempt; a fresh start resets the dedup marker so QA retries that
    // re-enter a node get their own start.
    reemitSseEventToSink({
      event: "on_chain_start",
      metadata: {
        langgraph_node: "AssetGenerator",
        langgraph_triggers: ["__start__"],
      },
    });
    reemitSseEventToSink({
      event: "on_chain_start",
      metadata: {
        langgraph_node: "AssetGenerator",
        langgraph_triggers: ["__start__"],
      },
    });

    const starts = sharedEvents.filter((e) => e.event === "node_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].attempt).toBe(1);
  });

  it("emits llm_call events for chat model start and end", () => {
    reemitSseEventToSink({
      event: "on_chat_model_start",
      name: "openrouter/free",
      metadata: { langgraph_node: "ScriptPlanner", ls_provider: "openai" },
    });
    reemitSseEventToSink({
      event: "on_chat_model_end",
      name: "openrouter/free",
      metadata: { langgraph_node: "ScriptPlanner" },
      data: {
        output: {
          content: "hello world",
          usage_metadata: { prompt_tokens: 5, completion_tokens: 2 },
        },
      },
    });

    const llmEvents = sharedEvents.filter((e) => e.event === "llm_call");
    expect(llmEvents).toHaveLength(2);
    expect((llmEvents[0] as Record<string, unknown>).operation).toBe(
      "chat_model_start",
    );
    expect((llmEvents[1] as Record<string, unknown>).operation).toBe(
      "chat_model_end",
    );
    const end = llmEvents[1] as Record<string, unknown>;
    expect(end.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2 });
    expect(end.responseTextPreview).toBe("hello world");
  });

  it("returns silently when no sink is set", () => {
    setActiveSink(null);
    expect(() =>
      reemitSseEventToSink({
        event: "on_chain_start",
        metadata: { langgraph_node: "ResearchAgent" },
      }),
    ).not.toThrow();
  });
});
