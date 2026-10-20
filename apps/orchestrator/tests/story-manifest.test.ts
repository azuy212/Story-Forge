import { describe, it, expect } from "@jest/globals";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_VERSION,
  addWarning,
  createManifest,
  isStageDone,
  loadOrCreateManifest,
  saveManifest,
  setStage,
  stageFingerprint,
  updateStageMetrics,
} from "../src/story/manifest.js";
import {
  atomicWriteFile,
  readFileText,
  readJsonFile,
  writeJsonFile,
} from "../src/story/atomic.js";
import type { ResolvedStoryConfig, StoryManifest } from "../src/story/types.js";

const CONFIG: ResolvedStoryConfig = {
  topic: "The long night at sea",
  targetDurationSec: 150,
  language: "en",
  tone: undefined,
  style: "stickman-history",
  jobId: "",
  outputDir: undefined,
  wpm: 150,
  imageConcurrency: 1,
  sceneMinSec: 3,
  sceneTargetMinSec: 6,
  sceneTargetMaxSec: 12,
  sceneSoftMaxSec: 15,
  width: 1920,
  height: 1080,
  fps: 30,
  sceneGapMs: 200,
  imageMinWidth: 1000,
  imageMinHeight: 540,
  imageMinAspect: 1.6,
  imageMaxAspect: 1.9,
  ttsMaxChars: 450,
  subtitleMaxCharsPerLine: 42,
  subtitleMinDurationMs: 800,
  crf: 19,
  preset: "medium",
};

const setup = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "story-manifest-"));

const teardown = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
};

describe("story stageFingerprint", () => {
  it("is stable for equal input regardless of key order", () => {
    expect(stageFingerprint({ a: 1, b: [1, 2] })).toBe(
      stageFingerprint({ b: [1, 2], a: 1 }),
    );
  });

  it("changes when the input changes", () => {
    expect(stageFingerprint({ a: 1 })).not.toBe(stageFingerprint({ a: 2 }));
  });
});

describe("story manifest lifecycle", () => {
  it("creates a fresh manifest with the unverified grounding source", () => {
    const manifest = createManifest(CONFIG, "job-1");
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.jobId).toBe("job-1");
    expect(manifest.groundingSource).toBe("model-knowledge");
    expect(manifest.unverified).toBe(true);
    expect(manifest.stages).toEqual({});
    expect(manifest.scenes).toEqual([]);
    expect(manifest.warnings).toEqual([]);
    expect(manifest.input).toMatchObject({
      topic: CONFIG.topic,
      targetDurationSec: 150,
      style: "stickman-history",
      jobId: "job-1",
    });
    expect(manifest.config.jobId).toBe("job-1");
  });

  it("round-trips through disk, keeping scenes and stage records", async () => {
    const dir = await setup();
    try {
      const path = join(dir, "manifest.json");

      const first = await loadOrCreateManifest(path, CONFIG, "job-1");
      expect(first.resumed).toBe(false);

      first.manifest.scenes.push({
        sceneId: 1,
        sentenceIds: ["s1"],
        narration: "One sentence.",
        wordCount: 2,
        visualPurpose: "p",
        imagePromptWarnings: [],
        status: {
          prompt: "done",
          image: "pending",
          audio: "pending",
          transcript: "pending",
          timing: "pending",
        },
        warnings: [],
      });
      setStage(first.manifest, "S2_story", {
        status: "done",
        fingerprint: "abc",
        durationMs: 12,
      });
      await saveManifest(path, first.manifest);

      const second = await loadOrCreateManifest(path, CONFIG, "job-1");
      expect(second.resumed).toBe(true);
      expect(second.manifest.scenes).toHaveLength(1);
      expect(second.manifest.scenes[0].narration).toBe("One sentence.");
      expect(second.manifest.stages.S2_story).toMatchObject({
        status: "done",
        fingerprint: "abc",
      });
      expect(isStageDone(second.manifest, "S2_story", "abc")).toBe(true);
    } finally {
      await teardown(dir);
    }
  });

  it("treats a stage left running by a crash as incomplete", async () => {
    const dir = await setup();
    try {
      const path = join(dir, "manifest.json");
      const manifest: StoryManifest = createManifest(CONFIG, "job-1");
      setStage(manifest, "S5_images", { status: "running" });
      await writeJsonFile(path, manifest);

      const loaded = await loadOrCreateManifest(path, CONFIG, "job-1");
      expect(loaded.manifest.stages.S5_images?.status).toBe("pending");
    } finally {
      await teardown(dir);
    }
  });

  it("ignores a manifest written by an unknown version", async () => {
    const dir = await setup();
    try {
      const path = join(dir, "manifest.json");
      await writeJsonFile(path, {
        ...createManifest(CONFIG, "job-1"),
        version: 99,
      });
      const loaded = await loadOrCreateManifest(path, CONFIG, "job-1");
      expect(loaded.resumed).toBe(false);
      expect(loaded.manifest.scenes).toEqual([]);
    } finally {
      await teardown(dir);
    }
  });

  it("merges stage patches without dropping earlier fields", () => {
    const manifest = createManifest(CONFIG, "job-1");
    setStage(manifest, "S3_scenes", { status: "running", startedAt: "t0" });
    setStage(manifest, "S3_scenes", { status: "done", fingerprint: "fp" });
    expect(manifest.stages.S3_scenes).toMatchObject({
      status: "done",
      startedAt: "t0",
      fingerprint: "fp",
    });

    updateStageMetrics(manifest, "S3_scenes", { scenes: 4 });
    updateStageMetrics(manifest, "S3_scenes", { attempts: 2 });
    expect(manifest.stages.S3_scenes).toMatchObject({
      status: "done",
      fingerprint: "fp",
      metrics: { scenes: 4, attempts: 2 },
    });
  });

  it("isStageDone requires a done status and, when given, a matching fingerprint", () => {
    const manifest = createManifest(CONFIG, "job-1");
    expect(isStageDone(manifest, "S1_input")).toBe(false);
    setStage(manifest, "S1_input", { status: "done", fingerprint: "fp1" });
    expect(isStageDone(manifest, "S1_input")).toBe(true);
    expect(isStageDone(manifest, "S1_input", "fp1")).toBe(true);
    expect(isStageDone(manifest, "S1_input", "fp2")).toBe(false);
  });

  it("deduplicates warnings", () => {
    const manifest = createManifest(CONFIG, "job-1");
    addWarning(manifest, "slow");
    addWarning(manifest, "slow");
    addWarning(manifest, "other");
    expect(manifest.warnings).toEqual(["slow", "other"]);
  });
});

describe("story atomic filesystem helpers", () => {
  it("writes JSON without leaving a temporary file behind", async () => {
    const dir = await setup();
    try {
      const path = join(dir, "nested", "value.json");
      await writeJsonFile(path, { a: 1 });

      expect(await readJsonFile<{ a: number }>(path)).toEqual({ a: 1 });
      const entries = await readdir(join(dir, "nested"));
      expect(entries).toEqual(["value.json"]);
      expect((await readFile(path, "utf-8")).endsWith("\n")).toBe(true);
    } finally {
      await teardown(dir);
    }
  });

  it("writes bytes verbatim and reads them back as text", async () => {
    const dir = await setup();
    try {
      const path = join(dir, "note.txt");
      await atomicWriteFile(path, "hello\n");
      expect(await readFileText(path)).toBe("hello\n");
    } finally {
      await teardown(dir);
    }
  });

  it("returns undefined for a missing or unparseable file", async () => {
    const dir = await setup();
    try {
      expect(await readJsonFile(join(dir, "missing.json"))).toBeUndefined();
      const path = join(dir, "garbage.json");
      await writeFile(path, "{not json");
      expect(await readJsonFile(path)).toBeUndefined();
    } finally {
      await teardown(dir);
    }
  });
});
