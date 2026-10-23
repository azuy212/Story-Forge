import { afterEach, describe, it, expect } from "@jest/globals";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseResolution,
  resolveStoryConfig,
  storyTtsMode,
} from "../src/story/config.js";
import { storyAssFontsDir } from "../src/story/render.js";
import {
  assertStoryInput,
  deriveJobId,
  validateStoryInput,
} from "../src/story/input.js";
import {
  jobDir,
  jobPaths,
  jobsRoot,
  packageRoot,
  sceneChunkPath,
  sceneImagePath,
  scenePartPath,
} from "../src/story/paths.js";
import { isPipelineError } from "../src/utils/errors.js";
import type { ResolvedStoryConfig } from "../src/story/types.js";

const STORY_ENV_KEYS = [
  "STORY_LANGUAGE",
  "STORY_TONE",
  "STORY_STYLE",
  "STORY_TTS_WPM",
  "STORY_TARGET_DURATION_SEC",
  "STORY_IMAGE_CONCURRENCY",
  "STORY_RESOLUTION",
  "STORY_FPS",
  "STORY_SCENE_GAP_MS",
  "STORY_JOBS_DIR",
  "STORY_PROMPTS_PATH",
  "STORY_TTS_MAX_CHARS",
  "STORY_SUBTITLE_MAX_CHARS_PER_LINE",
  "STORY_SUBTITLE_MIN_DURATION_MS",
  "STORY_CRF",
  "STORY_PRESET",
  "STORY_IMAGE_MIN_WIDTH",
  "STORY_IMAGE_MIN_HEIGHT",
  "STORY_IMAGE_MIN_ASPECT",
  "STORY_IMAGE_MAX_ASPECT",
];

const saved = new Map<string, string | undefined>();
for (const key of [
  ...STORY_ENV_KEYS,
  "NARRATION_GENERATION_MODE",
  "TARGET_DURATION_SEC",
  "NARRATION_TARGET_WPM",
]) {
  saved.set(key, process.env[key]);
}

const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const clearStoryEnv = (): void => {
  for (const key of STORY_ENV_KEYS) delete process.env[key];
};

afterEach(() => {
  for (const [key, value] of saved) restore(key, value);
});

const baseConfig = (
  overrides: Partial<ResolvedStoryConfig> = {},
): ResolvedStoryConfig => ({
  ...resolveStoryConfig({ topic: "The long night at sea" }),
  ...overrides,
});

describe("story parseResolution", () => {
  it("parses a WxH string in either case and either separator", () => {
    expect(parseResolution("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseResolution(" 1280 × 720 ")).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("falls back when the string is not a resolution", () => {
    expect(parseResolution("not-a-resolution")).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(parseResolution("99x99", { width: 640, height: 360 })).toEqual({
      width: 640,
      height: 360,
    });
  });
});

describe("story resolveStoryConfig", () => {
  it("applies the documented defaults", () => {
    clearStoryEnv();
    const config = resolveStoryConfig({ topic: "  Pirates  " });
    expect(config).toMatchObject({
      topic: "Pirates",
      targetDurationSec: 150,
      language: "en",
      tone: undefined,
      style: "stickman-history",
      wpm: 175,
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
      jobId: "",
    });
  });

  it("reads STORY_* variables and lets CLI flags win", () => {
    clearStoryEnv();
    process.env.STORY_TTS_WPM = "160";
    process.env.STORY_SCENE_GAP_MS = "250";

    const fromEnv = resolveStoryConfig({ topic: "x" });
    expect(fromEnv.wpm).toBe(160);
    expect(fromEnv.sceneGapMs).toBe(250);

    const fromCli = resolveStoryConfig({
      topic: "x",
      wpm: 170,
      sceneGapMs: 400,
      duration: 60,
      resolution: "1280x720",
      fps: 24,
      language: "ur",
      tone: "warm",
      style: "other-style",
      jobId: "fixed",
    });
    expect(fromCli).toMatchObject({
      wpm: 170,
      sceneGapMs: 400,
      targetDurationSec: 60,
      width: 1280,
      height: 720,
      fps: 24,
      language: "ur",
      tone: "warm",
      style: "other-style",
      jobId: "fixed",
    });
  });

  it("never inherits a Shorts-pipeline variable", () => {
    clearStoryEnv();
    process.env.NARRATION_GENERATION_MODE = "complete";
    process.env.TARGET_DURATION_SEC = "45";
    process.env.NARRATION_TARGET_WPM = "999";

    const config = resolveStoryConfig({ topic: "x" });
    expect(config.targetDurationSec).toBe(150);
    expect(config.wpm).toBe(175);
    // DP1: per-scene chunking is a constant, not an inherit-able mode.
    expect(storyTtsMode()).toBe("scene");
  });
});

describe("story validateStoryInput / assertStoryInput", () => {
  it("accepts a complete configuration", () => {
    expect(validateStoryInput(baseConfig({ jobId: "job-1" }))).toEqual([]);
  });

  it("reports every field that is wrong, once", () => {
    const issues = validateStoryInput(
      baseConfig({
        topic: "",
        targetDurationSec: 5,
        language: "english language",
        style: "",
        wpm: 0,
        fps: 29.5,
        imageMinAspect: 2,
        imageMaxAspect: 1.5,
      }),
    );
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      "fps",
      "imageAspect",
      "language",
      "style",
      "targetDurationSec",
      "topic",
      "wpm",
    ]);
    expect(
      issues.find((issue) => issue.field === "targetDurationSec")?.message,
    ).toContain("at least 10 seconds");
  });

  it("rejects a topic over 500 characters", () => {
    const issues = validateStoryInput(baseConfig({ topic: "x".repeat(501) }));
    expect(issues.map((issue) => issue.field)).toContain("topic");
    expect(issues[0].message).toContain("500 characters or fewer");
  });

  it("throws a single actionable error listing every issue", () => {
    let caught: unknown;
    try {
      assertStoryInput(baseConfig({ topic: "", fps: 0 }));
    } catch (error) {
      caught = error;
    }
    expect(isPipelineError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("STORY_INPUT_INVALID");
    expect((caught as Error).message).toContain(
      "topic: topic must not be empty",
    );
    expect((caught as Error).message).toContain("fps:");
  });
});

describe("story deriveJobId", () => {
  it("is deterministic for the same configuration", () => {
    const config = baseConfig();
    expect(deriveJobId(config)).toBe(deriveJobId(config));
  });

  it("slugifies the topic and appends eight hex characters", () => {
    const id = deriveJobId(baseConfig({ topic: "The Long Night at Sea!" }));
    expect(id).toMatch(/^the-long-night-at-sea-[0-9a-f]{8}$/);
  });

  it("changes when the topic or the shaping configuration changes", () => {
    const base = deriveJobId(baseConfig({ topic: "A" }));
    expect(deriveJobId(baseConfig({ topic: "B" }))).not.toBe(base);
    expect(
      deriveJobId(baseConfig({ topic: "A", targetDurationSec: 60 })),
    ).not.toBe(base);
    expect(deriveJobId(baseConfig({ topic: "A", style: "other" }))).not.toBe(
      base,
    );
    expect(deriveJobId(baseConfig({ topic: "A", language: "ur" }))).not.toBe(
      base,
    );
    // Only the configuration that shapes the story is hashed, so a change to
    // the audio rate resumes the same job directory.
    expect(deriveJobId(baseConfig({ topic: "A", wpm: 170 }))).toBe(base);
  });

  it("uses an explicit job id verbatim", () => {
    expect(deriveJobId(baseConfig({ jobId: "my-job" }))).toBe("my-job");
  });
});

describe("story paths", () => {
  it("anchors the default jobs root to the package, not the process CWD", () => {
    clearStoryEnv();
    expect(jobsRoot()).toBe(join(packageRoot(), "jobs"));
    expect(jobDir("job-1")).toBe(join(packageRoot(), "jobs", "job-1"));
  });

  it("uses an explicit output dir to hold the job folder", () => {
    expect(jobDir("job-1", "/tmp/outputs")).toBe("/tmp/outputs/job-1");
  });

  it("does not double-nest when the output dir is already the job folder", () => {
    expect(jobDir("job-1", "/tmp/outputs/job-1")).toBe("/tmp/outputs/job-1");
  });

  it("lays out every artifact under the job directory", () => {
    const paths = jobPaths("/tmp/job-1");
    expect(paths.manifest).toBe("/tmp/job-1/manifest.json");
    expect(paths.finalVideo).toBe("/tmp/job-1/final.mp4");
    expect(paths.narration).toBe("/tmp/job-1/audio/narration.wav");
    expect(paths.subtitlesAss).toBe("/tmp/job-1/subtitles.ass");
    expect(paths.subtitlesSrt).toBe("/tmp/job-1/subtitles.srt");
    expect(sceneImagePath(paths, 7)).toBe("/tmp/job-1/images/scene-007.png");
    expect(sceneChunkPath(paths, 12)).toBe(
      "/tmp/job-1/audio/chunks/scene-012.wav",
    );
    expect(scenePartPath(paths, 3, 2)).toBe(
      "/tmp/job-1/audio/parts/scene-003-part02.wav",
    );
  });
});

describe("story subtitle fonts", () => {
  it("ships the bold face the ASS style names", () => {
    // The style asks libass for "Noto Sans"; without the file every machine
    // resolves it through fontconfig and the subtitles look different (or fall
    // back to a thin face) on each render host.
    clearStoryEnv();
    const fontsDir = storyAssFontsDir();
    expect(fontsDir).toBe(join(packageRoot(), "assets", "branding"));
    expect(existsSync(join(fontsDir as string, "NotoSans-Bold.ttf"))).toBe(
      true,
    );
  });

  it("ships an Arabic-script fallback for Urdu and Persian jobs", () => {
    clearStoryEnv();
    expect(
      existsSync(
        join(packageRoot(), "assets", "branding", "NotoNaskhArabic-Bold.ttf"),
      ),
    ).toBe(true);
  });
});
