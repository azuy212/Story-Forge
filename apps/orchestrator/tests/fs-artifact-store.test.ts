import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemArtifactStore } from "../src/artifacts/fs/fs-artifact-store.js";
import { resetRunNamespaces } from "../src/artifacts/namespace.js";
import type { ArtifactReference } from "../src/artifacts/types.js";

let dir: string;
let store: FilesystemArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
  process.env.ARTIFACT_STORE_DIR = dir;
  store = new FilesystemArtifactStore();
  resetRunNamespaces();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ARTIFACT_STORE_DIR;
});

const RUN_ID = "run-001";

async function saveComplete(value: unknown, meta: Record<string, unknown> = {}): Promise<ArtifactReference> {
  return store.save(RUN_ID, "script", value, {
    inputHash: "hash-" + JSON.stringify(value),
    runId: RUN_ID,
    node: "ScriptWriter",
    ...meta,
  }, "complete");
}

describe("FilesystemArtifactStore", () => {
  it("saves a complete artifact and reads it back", async () => {
    const ref = await saveComplete({ title: "T", narration: "N" });

    expect(ref.type).toBe("script");
    expect(ref.version).toBe(1);
    expect(ref.runId).toBe(RUN_ID);

    const record = await store.load<{ title: string }>(ref);
    expect(record?.status).toBe("complete");
    expect(record?.data.title).toBe("T");
    expect(record?.schemaVersion).toBe(1);
  });

  it("increments version on each save, never overwrites", async () => {
    await saveComplete({ v: 1 });
    await saveComplete({ v: 2 });
    const ref3 = await saveComplete({ v: 3 });

    expect(ref3.version).toBe(3);

    const versions = await store.listVersions(RUN_ID, "script");
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);

    const latest = await store.latest<{ v: number }>(RUN_ID, "script");
    expect(latest?.version).toBe(3);
    expect(latest?.data.v).toBe(3);
  });

  it("returns null from latest when nothing saved", async () => {
    const latest = await store.latest(RUN_ID, "script");
    expect(latest).toBeNull();
  });

  it("returns null from latest when the stored file is corrupt", async () => {
    const ref = await saveComplete({ v: 1 });
    await store.markStatus(RUN_ID, "script", 1, "complete");

    const { writeFile } = await import("node:fs/promises");
    await writeFile(ref.location, "{ not valid json", "utf-8");

    const latest = await store.latest(RUN_ID, "script");
    expect(latest).toBeNull();
  });

  it("markStatus rolls latest back to previous complete version", async () => {
    await saveComplete({ v: 1 });
    const ref2 = await saveComplete({ v: 2 });

    await store.markStatus(RUN_ID, "script", ref2.version, "superseded");

    const latest = await store.latest<{ v: number }>(RUN_ID, "script");
    expect(latest?.version).toBe(1);
  });

  it("markStatus can flip a pending artifact to complete and it becomes the cacheable latest", async () => {
    const ref1 = await saveComplete({ v: 1 });
    const ref2 = await store.save(RUN_ID, "script", { v: 2 }, { inputHash: "h2", runId: RUN_ID }, "pending");

    const latestBefore = await store.latest<{ v: number }>(RUN_ID, "script");
    expect(latestBefore?.version).toBe(2);
    expect(latestBefore?.status).toBe("pending");

    await store.markStatus(RUN_ID, "script", ref2.version, "complete");

    const latestAfter = await store.latest<{ v: number }>(RUN_ID, "script");
    expect(latestAfter?.version).toBe(2);
    expect(latestAfter?.status).toBe("complete");

    void ref1;
  });

  it("recordRef writes refs into state/execution.json", async () => {
    const ref = await saveComplete({ v: 1 });
    await store.recordRef(RUN_ID, ref);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(join(dir, RUN_ID, "state", "execution.json"), "utf-8");
    const parsed = JSON.parse(content) as Record<string, ArtifactReference>;
    expect(parsed["script@v1"].artifactId).toBe(ref.artifactId);
    expect(parsed["script@v1"].runId).toBe(RUN_ID);
  });

  it("getRunId resolves config runId, then humanized thread_id, then state", () => {
    expect(store.getRunId({ runId: "a" })).toBe("a");
    const human = store.getRunId({ thread_id: "b" });
    expect(human).toMatch(/^untitled-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(store.getRunId({ thread_id: "b" })).toBe(human);
    expect(store.getRunId({ thread_id: "b", runId: "a" })).toBe("a");
    expect(store.getRunId({}, { execution: { runId: "c" } })).toBe("c");
    expect(store.getRunId({})).toBeNull();
  });
});
