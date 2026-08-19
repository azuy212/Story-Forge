import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRunStamp,
  resolveRunNamespace,
  resolveUnnamedRun,
  resetRunNamespaces,
  getRunsDir,
} from "../src/artifacts/namespace.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "namespace-test-"));
  process.env.ARTIFACT_STORE_DIR = dir;
  resetRunNamespaces();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ARTIFACT_STORE_DIR;
  resetRunNamespaces();
});

describe("formatRunStamp", () => {
  it("formats a date as YYYYMMDD-HHmmss", () => {
    expect(formatRunStamp(new Date(2026, 7, 13, 8, 42, 3))).toBe(
      "20260813-084203",
    );
  });

  it("zero-pads all components", () => {
    expect(formatRunStamp(new Date(2026, 0, 5, 0, 7, 9))).toBe(
      "20260105-000709",
    );
  });
});

describe("resolveRunNamespace", () => {
  it("produces slug-stamp-suffix names", () => {
    const name = resolveRunNamespace("thread-1", "Unrecognized Countries");
    expect(name).toMatch(/^unrecognized-countries-\d{8}-\d{6}-[0-9a-f]{4}$/);
  });

  it("falls back to untitled without a topic", () => {
    const name = resolveRunNamespace("thread-2");
    expect(name).toMatch(/^untitled-\d{8}-\d{6}-[0-9a-f]{4}$/);
  });

  it("is memoized per thread: repeated calls return the same name", () => {
    const first = resolveRunNamespace("thread-3", "Topic A");
    const second = resolveRunNamespace("thread-3", "Topic A");
    expect(second).toBe(first);
  });

  it("persists across a fresh process via the disk index", () => {
    const first = resolveRunNamespace("thread-4", "Topic B");
    resetRunNamespaces();
    const again = resolveRunNamespace("thread-4", "Topic B");
    expect(again).toBe(first);
  });

  it("keeps the namespace stable when the topic changes after a restart", () => {
    const first = resolveRunNamespace("thread-4b", "Topic A");
    resetRunNamespaces();
    const second = resolveRunNamespace("thread-4b", "Topic B");
    expect(second).toBe(first);
  });

  it("reuses an existing disk entry instead of generating a new name", () => {
    mkdirSync(join(dir, ".run-names"), { recursive: true });
    writeFileSync(
      join(dir, ".run-names", "thread-5"),
      "already-chosen-name",
      "utf-8",
    );
    expect(resolveRunNamespace("thread-5", "Topic C")).toBe(
      "already-chosen-name",
    );
  });

  it("never embeds a raw thread_id in the index path", () => {
    resolveRunNamespace("../../evil/thread", "Topic D");
    const files = readdirSync(join(dir, ".run-names"));
    expect(files).toContain(".._.._evil_thread");
    expect(files).not.toContain("../../evil/thread");
    const stored = readFileSync(
      join(dir, ".run-names", ".._.._evil_thread"),
      "utf-8",
    );
    expect(stored).toMatch(/^topic-d-\d{8}-\d{6}-[0-9a-f]{4}$/);
  });

  it("writes the index under the configured runs dir", () => {
    resolveRunNamespace("thread-6", "Topic E");
    expect(getRunsDir()).toBe(dir);
    expect(readdirSync(join(dir, ".run-names"))).toContain("thread-6");
  });

  it("writes run.json with threadId, topic, pillar on first claim", () => {
    const name = resolveRunNamespace(
      "thread-runmeta-1",
      "Test Topic",
      "Test Pillar",
    );
    const metaPath = join(dir, name, "run.json");
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.threadId).toBe("thread-runmeta-1");
    expect(meta.topic).toBe("Test Topic");
    expect(meta.pillar).toBe("Test Pillar");
    expect(meta.createdAt).toBeDefined();
    expect(meta.threadHistory).toEqual(["thread-runmeta-1"]);
  });

  it("does not duplicate threadHistory on re-claim by same thread", () => {
    const name = resolveRunNamespace(
      "thread-runmeta-2",
      "Test Topic",
      "Test Pillar",
    );
    const metaPath = join(dir, name, "run.json");
    let meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.threadHistory).toEqual(["thread-runmeta-2"]);

    resolveRunNamespace("thread-runmeta-2", "Test Topic", "Test Pillar");
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.threadHistory).toEqual(["thread-runmeta-2"]);
    expect(meta.threadHistory).toHaveLength(1);
  });

  it("preserves run.json fields when same thread re-claims with different topic", () => {
    const name = resolveRunNamespace(
      "thread-runmeta-3",
      "Original Topic",
      "Original Pillar",
    );
    resetRunNamespaces();
    resolveRunNamespace("thread-runmeta-3", "Changed Topic", "Changed Pillar");
    const meta = JSON.parse(readFileSync(join(dir, name, "run.json"), "utf-8"));
    expect(meta.topic).toBe("Original Topic");
    expect(meta.pillar).toBe("Original Pillar");
    expect(meta.createdAt).toBeDefined();
    expect(meta.threadHistory).toEqual(["thread-runmeta-3"]);
  });
});

describe("resolveUnnamedRun", () => {
  it("is memoized per topic within a process", () => {
    const first = resolveUnnamedRun("Geography");
    const second = resolveUnnamedRun("Geography");
    expect(second).toBe(first);
    expect(first).toMatch(/^geography-\d{8}-\d{6}-[0-9a-f]{4}$/);
  });

  it("gives different topics different names", () => {
    expect(resolveUnnamedRun("Alpha")).not.toBe(resolveUnnamedRun("Beta"));
  });

  it("resets with resetRunNamespaces", () => {
    const first = resolveUnnamedRun("Fresh Topic");
    resetRunNamespaces();
    expect(resolveUnnamedRun("Fresh Topic")).not.toBe(first);
  });
});
