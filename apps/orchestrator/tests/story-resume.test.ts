import { afterAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../src/story/atomic.js";
import type { StoryAgents } from "../src/story/agents.js";
import { resolveStoryConfig } from "../src/story/config.js";
import { createManifest, saveManifest } from "../src/story/manifest.js";
import { jobDir, jobPaths } from "../src/story/paths.js";
import { reconcileResumeConfig } from "../src/story/resume.js";
import { characterRegistryFingerprint, runStoryJob } from "../src/story/run.js";
import type { ResolvedStoryConfig } from "../src/story/types.js";

/**
 * Resume semantics: a resumed job replays the configuration stored in its
 * manifest, and a flag that disagrees with it is an error.
 *
 * Regression: `story --from S6_audio` (no `--duration 45`) re-resolved the
 * config from the defaults, changed the S2/S3 fingerprints, and re-authored a
 * 45 s job at 150 s. Every stage fingerprint is a hash of config fields, so a
 * changed config is a different job — it must be refused, not silently applied.
 */

const TOPIC = "The long night at sea";
const JOB_ID = "resume-job";

const ROOT = mkdtempSync(join(tmpdir(), "story-resume-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function baseConfig(
  overrides: Partial<ResolvedStoryConfig> = {},
): ResolvedStoryConfig {
  return {
    topic: TOPIC,
    targetDurationSec: 45,
    language: "en",
    tone: undefined,
    style: "stickman-history",
    jobId: JOB_ID,
    outputDir: ROOT,
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
    asrVerify: true,
    subtitleMaxCharsPerLine: 42,
    subtitleMinDurationMs: 800,
    crf: 19,
    preset: "medium",
    ...overrides,
  };
}

/** A job directory holding a manifest with a stored config. */
async function seedJob(dir: string, stored: ResolvedStoryConfig) {
  const paths = jobPaths(jobDir(JOB_ID, dir));
  await ensureDir(paths.dir);
  await saveManifest(paths.manifest, createManifest(stored, JOB_ID));
  return paths;
}

function spyAgents(counter: { calls: number }): StoryAgents {
  const record = async () => {
    counter.calls += 1;
    return {
      data: null,
      error: "agents must not run on a resume that changes the configuration",
      telemetry: {},
    };
  };
  return {
    writeStory: record,
    verifyStory: record,
    planScenes: record,
    designCharacters: record,
    planSceneVisuals: record,
  };
}

describe("reconcileResumeConfig", () => {
  it("replays the stored configuration instead of the environment", () => {
    const effective = reconcileResumeConfig({
      stored: baseConfig({ targetDurationSec: 45, wpm: 150 }),
      requested: baseConfig({ targetDurationSec: 150, wpm: 170 }),
      overrides: {},
    });

    expect(effective.targetDurationSec).toBe(45);
    expect(effective.wpm).toBe(150);
  });

  it("rejects an explicit flag that disagrees with the manifest", () => {
    expect(() =>
      reconcileResumeConfig({
        stored: baseConfig({ targetDurationSec: 45 }),
        requested: baseConfig({ targetDurationSec: 150 }),
        overrides: { duration: 150 },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "STORY_CONFIG_CONFLICT",
        message: expect.stringContaining("--duration"),
      }),
    );
  });

  it("names both values so the stored config is easy to restore", () => {
    let message = "";
    try {
      reconcileResumeConfig({
        stored: baseConfig({ targetDurationSec: 33 }),
        requested: baseConfig({ targetDurationSec: 150 }),
        overrides: { duration: 150 },
      });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("--duration");
    expect(message).toContain("33");
    expect(message).toContain("150");
    expect(message).toContain("--job-id");
  });

  it("rejects a changed topic, style or resolution", () => {
    const cases: Array<{
      overrides: Parameters<typeof reconcileResumeConfig>[0]["overrides"];
      requested: ResolvedStoryConfig;
      flag: string;
    }> = [
      {
        overrides: { topic: "A different topic" },
        requested: baseConfig({ topic: "A different topic" }),
        flag: "topic",
      },
      {
        overrides: { style: "stickman-modern" },
        requested: baseConfig({ style: "stickman-modern" }),
        flag: "--style",
      },
      {
        overrides: { resolution: "1280x720" },
        requested: baseConfig({ width: 1280, height: 720 }),
        flag: "--resolution",
      },
    ];

    for (const entry of cases) {
      expect(() =>
        reconcileResumeConfig({
          stored: baseConfig(),
          requested: entry.requested,
          overrides: entry.overrides,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "STORY_CONFIG_CONFLICT",
          message: expect.stringContaining(entry.flag),
        }),
      );
    }
  });

  it("allows execution-only overrides and adopts them", () => {
    const effective = reconcileResumeConfig({
      stored: baseConfig({ imageConcurrency: 1 }),
      requested: baseConfig({ imageConcurrency: 4, outputDir: "/moved/job" }),
      overrides: { imageConcurrency: 4, outputDir: "/moved/job" },
    });

    expect(effective.imageConcurrency).toBe(4);
    expect(effective.outputDir).toBe("/moved/job");
    expect(effective.targetDurationSec).toBe(45);
  });

  it("falls back to the requested value for keys the manifest predates", () => {
    const stored = baseConfig();
    delete (stored as Partial<ResolvedStoryConfig>).asrVerify;

    const effective = reconcileResumeConfig({
      stored,
      requested: baseConfig({ asrVerify: true }),
      overrides: {},
    });

    expect(effective.asrVerify).toBe(true);
  });
});

describe("runStoryJob resume", () => {
  it("refuses a conflicting flag before any agent runs or the manifest is touched", async () => {
    const dir = join(ROOT, "conflict");
    const paths = await seedJob(dir, baseConfig({ targetDurationSec: 45 }));
    const before = readFileSync(paths.manifest, "utf8");
    const counter = { calls: 0 };

    await expect(
      runStoryJob({
        topic: TOPIC,
        jobId: JOB_ID,
        outputDir: dir,
        duration: 150,
        agents: spyAgents(counter),
      }),
    ).rejects.toMatchObject({ code: "STORY_CONFIG_CONFLICT" });

    expect(counter.calls).toBe(0);
    expect(readFileSync(paths.manifest, "utf8")).toBe(before);
  });

  it("uses the stored duration on a resume even when the default differs", async () => {
    const dir = join(ROOT, "stored-wins");
    const stored = baseConfig({ targetDurationSec: 33, wpm: 150 });
    await seedJob(dir, stored);

    const result = await runStoryJob({
      topic: TOPIC,
      jobId: JOB_ID,
      outputDir: dir,
      dryRun: true,
    });

    expect(result.plan?.wordBudget).toBe(
      Math.round((stored.targetDurationSec * stored.wpm) / 60),
    );
  });

  it("leaves a job with no manifest free to start at any duration", async () => {
    const dir = join(ROOT, "fresh");

    const result = await runStoryJob({
      topic: TOPIC,
      jobId: JOB_ID,
      outputDir: dir,
      duration: 150,
      dryRun: true,
    });

    expect(result.status).toBe("stopped");
    expect(result.plan?.wordBudget).toBeGreaterThan(0);
  });
});

describe("characterRegistryFingerprint", () => {
  const base = {
    story: "A story.",
    language: "en",
    styleId: "stickman-history",
    style: { id: "stickman-history", promptTemplate: "A template." },
    characterPrompt: "The registry prompt.",
  };

  it("is stable when nothing changed", () => {
    expect(characterRegistryFingerprint(base)).toBe(
      characterRegistryFingerprint({ ...base }),
    );
  });

  it("changes when the character prompt changes, so a stored registry is re-planned", () => {
    expect(
      characterRegistryFingerprint({
        ...base,
        characterPrompt: "The registry prompt, with the split rule.",
      }),
    ).not.toBe(characterRegistryFingerprint(base));
  });

  it("changes when the story or the style changes", () => {
    expect(
      characterRegistryFingerprint({ ...base, story: "Another story." }),
    ).not.toBe(characterRegistryFingerprint(base));
    expect(
      characterRegistryFingerprint({
        ...base,
        style: { id: "stickman-history", promptTemplate: "Another template." },
      }),
    ).not.toBe(characterRegistryFingerprint(base));
  });
});
