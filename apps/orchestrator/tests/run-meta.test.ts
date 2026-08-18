import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createOrAppendRunMeta,
  runMetaPath,
} from "../src/artifacts/run-meta.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-meta-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readMeta = (runId: string) =>
  JSON.parse(readFileSync(runMetaPath(dir, runId), "utf-8"));

async function runConcurrent(threadIds: string[], runId: string) {
  const metaModule = fileURLToPath(
    new URL("../src/artifacts/run-meta.mjs", import.meta.url),
  );
  const script = `
      import { createOrAppendRunMeta } from ${JSON.stringify(metaModule)};
      const [runsDir, runId, threadId] = [process.argv[1], process.argv[2], process.argv[3]];
      createOrAppendRunMeta(runsDir, runId, { threadId, topic: "T" });
    `;

  const results = await Promise.all(
    threadIds.map(
      (threadId) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [
            "--input-type=module",
            "-e",
            script,
            dir,
            runId,
            threadId,
          ]);
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
          );
          child.on("error", reject);
        }),
    ),
  );
  await results;
}

describe("createOrAppendRunMeta", () => {
  it("creates run.json with threadId, topic, pillar and history on first claim", () => {
    const meta = createOrAppendRunMeta(dir, "run-1", {
      threadId: "t1",
      topic: "Topic",
      pillar: "Pillar",
    });
    expect(meta).toMatchObject({
      threadId: "t1",
      topic: "Topic",
      pillar: "Pillar",
      threadHistory: ["t1"],
    });
    expect(meta.createdAt).toBeDefined();
  });

  it("appends a new threadId without losing previous history", () => {
    createOrAppendRunMeta(dir, "run-2", { threadId: "t1", topic: "T" });
    createOrAppendRunMeta(dir, "run-2", { threadId: "t2", topic: "T" });
    expect(readMeta("run-2").threadHistory).toEqual(["t1", "t2"]);
  });

  it("dedupes a threadId already present", () => {
    createOrAppendRunMeta(dir, "run-3", { threadId: "t1", topic: "T" });
    createOrAppendRunMeta(dir, "run-3", { threadId: "t1", topic: "T" });
    expect(readMeta("run-3").threadHistory).toEqual(["t1"]);
  });

  it("preserves original topic, pillar and createdAt on append", () => {
    const first = createOrAppendRunMeta(dir, "run-4", {
      threadId: "t1",
      topic: "Original",
      pillar: "P1",
    });
    const second = createOrAppendRunMeta(dir, "run-4", {
      threadId: "t2",
      topic: "Changed",
      pillar: "P2",
    });
    expect(second.topic).toBe("Original");
    expect(second.pillar).toBe("P1");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.threadHistory).toEqual(["t1", "t2"]);
  });

  it("handles a concurrent first-claim race without losing a threadId", async () => {
    const runId = "run-race";
    const threadIds = ["t-a", "t-b", "t-c", "t-d"];
    await runConcurrent(threadIds, runId);

    expect(existsSync(runMetaPath(dir, runId))).toBe(true);
    const persisted = readMeta(runId);
    expect(persisted.threadHistory).toHaveLength(threadIds.length);
    expect([...persisted.threadHistory].sort()).toEqual(threadIds.sort());
    expect(persisted.topic).toBe("T");
    expect(persisted.createdAt).toEqual(expect.any(String));
    expect(persisted.threadHistory).not.toContain(null);
  });

  it("handles concurrent appends to an existing file without losing a threadId", async () => {
    const runId = "run-append-race";
    createOrAppendRunMeta(dir, runId, { threadId: "t0", topic: "T" });

    const appenders = ["t1", "t2", "t3", "t4"];
    await runConcurrent(appenders, runId);

    const persisted = readMeta(runId);
    expect(persisted.threadHistory).toHaveLength(appenders.length + 1);
    expect([...persisted.threadHistory].sort()).toEqual(
      ["t0", ...appenders].sort(),
    );
    expect(persisted.topic).toBe("T");
    expect(persisted.threadHistory).not.toContain(null);
  });

  it("reclaims a stale lock from a dead PID", () => {
    const runId = "run-stale";
    const lockDir = join(dir, runId, "run.json.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 999_999_999, createdAt: Date.now() }),
      "utf-8",
    );

    const meta = createOrAppendRunMeta(dir, runId, {
      threadId: "t1",
      topic: "T",
    });

    expect(existsSync(lockDir)).toBe(false);
    expect(meta.threadHistory).toEqual(["t1"]);
  });

  it("does not reclaim a live lock owned by the current process", () => {
    const runId = "run-live-lock";
    const lockDir = join(dir, runId, "run.json.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      "utf-8",
    );

    expect(() =>
      createOrAppendRunMeta(dir, runId, { threadId: "t1", topic: "T" }),
    ).toThrow("Timed out waiting for lock");
    expect(existsSync(lockDir)).toBe(true);
  });
});
