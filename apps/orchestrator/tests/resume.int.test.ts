import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { FilesystemArtifactStore } from "../src/artifacts/fs/fs-artifact-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.setTimeout(30_000);

let testDir: string;
let artifactStore: FilesystemArtifactStore;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "resume-test-"));
  process.env.ARTIFACT_STORE_DIR = testDir;
  artifactStore = new FilesystemArtifactStore();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.ARTIFACT_STORE_DIR;
});

describe("Artifact resume functionality", () => {
  it("allows resuming a run with the same runId and reads existing artifacts", async () => {
    const runId = "resume-test-run";

    // First run: create some artifacts
    const ref1 = await artifactStore.save(runId, "research", { summary: "test", facts: [] }, { inputHash: "hash1" }, "complete");
    const ref2 = await artifactStore.save(runId, "script", { text: "script content" }, { inputHash: "hash2" }, "complete");

    expect(ref1.version).toBe(1);
    expect(ref2.version).toBe(1);

    // Verify artifacts exist
    const manifest = await artifactStore.getManifest(runId);
    expect(manifest?.research?.latest).toBe("v1");
    expect(manifest?.script?.latest).toBe("v1");

    // Second run with same runId: should be able to read existing artifacts
    const loaded1 = await artifactStore.load({ ...ref1, runId });
    const loaded2 = await artifactStore.load({ ...ref2, runId });

    expect(loaded1?.data).toEqual({ summary: "test", facts: [] });
    expect(loaded2?.data).toEqual({ text: "script content" });

    // Verify cache hit would work - latest artifact matches input hash
    const latest = await artifactStore.latest(runId, "research");
    expect(latest).not.toBeNull();
    expect(latest?.meta.inputHash).toBe("hash1");
  });

  it("creates new artifact versions when input hash changes", async () => {
    const runId = "resume-test-run-2";

    // First version
    await artifactStore.save(runId, "research", { summary: "v1" }, { inputHash: "hash-v1" }, "complete");

    // Second version with different input hash
    await artifactStore.save(runId, "research", { summary: "v2" }, { inputHash: "hash-v2" }, "complete");

    const manifest = await artifactStore.getManifest(runId);
    expect(manifest?.research?.versions).toHaveLength(2);
    expect(manifest?.research?.latest).toBe("v2");

    // Latest should be v2
    const latest = await artifactStore.latest(runId, "research");
    expect(latest?.version).toBe(2);
    expect(latest?.data).toEqual({ summary: "v2" });
  });

  it("finds completed artifacts by input hash across versions", async () => {
    const runId = "resume-test-run-3";

    // Create multiple versions
    await artifactStore.save(runId, "prompts", { data: "v1" }, { inputHash: "hash-a" }, "complete");
    await artifactStore.save(runId, "prompts", { data: "v2" }, { inputHash: "hash-b" }, "complete");
    await artifactStore.save(runId, "prompts", { data: "v3" }, { inputHash: "hash-a" }, "complete"); // Same hash as v1

    // Should find v3 (latest with matching hash)
    const found = await artifactStore.findCompleteByInputHash(runId, "prompts", "hash-a");
    expect(found).not.toBeNull();
    expect(found?.record.version).toBe(3);
    expect(found?.record.data).toEqual({ data: "v3" });
  });
});