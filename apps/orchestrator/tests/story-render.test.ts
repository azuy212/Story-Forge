import { afterAll, describe, expect, it } from "@jest/globals";
import { execa } from "execa";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStoryConfig } from "../src/story/config.js";
import { detectBlack } from "../src/story/media.js";
import { jobPaths } from "../src/story/paths.js";
import {
  frameMatchVerdict,
  gateChecksPassed,
  runRenderStage,
} from "../src/story/render.js";
import type { StoryScene } from "../src/story/types.js";
import type { SubtitleCue } from "../src/story/subtitles.js";

/**
 * Frame-vs-source tuning and render failure hygiene.
 *
 * The frame check compares a sampled video frame with every scene's source
 * image. Real stickman scenes share a palette, so the rule is a MARGIN over
 * the best-scoring other scene, not an absolute similarity threshold.
 */
describe("frame-vs-source verdict", () => {
  it("passes when the frame matches its own source by a clear margin", () => {
    const verdict = frameMatchVerdict(0.82, { sceneId: 4, value: 0.71 });
    expect(verdict.passed).toBe(true);
    expect(verdict.margin).toBeCloseTo(0.11, 5);
  });

  it("fails when another scene's image matches at least as well", () => {
    // The signature of a wrong image on screen: the neighbour wins.
    expect(frameMatchVerdict(0.86, { sceneId: 7, value: 0.88 }).passed).toBe(
      false,
    );
  });

  it("fails on a thin margin inside the tolerance", () => {
    // 0.01 < the 0.02 margin: too close to call, reported as a warning.
    const verdict = frameMatchVerdict(0.9, { sceneId: 2, value: 0.89 });
    expect(verdict.passed).toBe(false);
    expect(verdict.margin).toBeCloseTo(0.01, 5);
  });

  it("passes a lone scene when the frame still resembles an illustration", () => {
    expect(frameMatchVerdict(0.55, { sceneId: 0, value: -2 }).passed).toBe(
      true,
    );
  });

  it("fails a frame that resembles nothing at all", () => {
    expect(frameMatchVerdict(0.1, { sceneId: 0, value: -2 }).passed).toBe(
      false,
    );
  });
});

/**
 * A failed FFmpeg run must leave no final.mp4 and no half-written temp file,
 * including when the job path contains spaces and a quote (the case where
 * naive shell string building breaks).
 */
describe("render failure hygiene", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("leaves no final.mp4 when the subtitle file cannot be opened", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-render-fail-"));
    roots.push(root);
    const dir = join(root, `job "with space"`);
    const paths = jobPaths(dir);
    await mkdir(paths.imagesDir, { recursive: true });
    await mkdir(paths.audioDir, { recursive: true });
    await mkdir(paths.renderDir, { recursive: true });

    let available = true;
    try {
      await execa("ffmpeg", ["-version"]);
    } catch {
      available = false;
    }
    if (!available) {
      console.warn("ffmpeg is not installed; skipping render failure test");
      return;
    }

    const imagePaths: string[] = [];
    for (const [index, colour] of ["red", "blue"].entries()) {
      const imagePath = join(paths.imagesDir, `scene-00${index + 1}.png`);
      await execa("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=${colour}:s=640x360`,
        "-frames:v",
        "1",
        imagePath,
      ]);
      imagePaths.push(imagePath);
    }
    await execa("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-ar",
      "48000",
      "-ac",
      "1",
      paths.narration,
    ]);

    const scene = (sceneId: number, imagePath: string): StoryScene => ({
      sceneId,
      sentenceIds: [`s${sceneId}`],
      narration: `Scene ${sceneId}.`,
      wordCount: 2,
      visualPurpose: "fixture",
      imagePromptWarnings: [],
      image: {
        path: imagePath,
        prompt: "fixture",
        provider: "fixture",
        attempts: 1,
        promptHash: "0",
        byteSize: 1,
        width: 640,
        height: 360,
        aspect: 640 / 360,
        luminanceVariance: 1,
        generatedAt: new Date(0).toISOString(),
      },
      status: {
        prompt: "done",
        image: "done",
        audio: "done",
        transcript: "done",
        timing: "done",
      },
      warnings: [],
    });

    const config = resolveStoryConfig({ resolution: "640x360", fps: 30 });
    // cues non-empty => subtitles.ass is referenced but deliberately missing
    const cues: SubtitleCue[] = [
      { index: 1, startMs: 0, endMs: 1000, lines: ["Scene one."] },
      { index: 2, startMs: 1000, endMs: 2000, lines: ["Scene two."] },
    ];

    await expect(
      runRenderStage({
        scenes: [scene(1, imagePaths[0]), scene(2, imagePaths[1])],
        paths,
        config,
        cues,
        frames: [30, 30],
        audioDurationSec: 2,
        runId: "fixture",
      }),
    ).rejects.toThrow();

    await expect(access(paths.finalVideo)).rejects.toThrow();
    await expect(
      access(join(paths.renderDir, "final.tmp.mp4")),
    ).rejects.toThrow();
  }, 120_000);
});

/**
 * `blackdetect` must catch an empty frame, not a dark painting. The sample
 * story has a pre-dawn scene and a stormy scene, so the pixel threshold is
 * lowered and the picture-black ratio raised: only a frame with essentially no
 * lit pixels counts.
 */
describe("black-frame detection threshold", () => {
  it("ignores a dark night scene with a thin white figure", async () => {
    if (!(await ffmpegAvailable())) return;
    const root = await mkdtemp(join(tmpdir(), "story-black-"));
    try {
      const video = join(root, "night.mp4");
      await execa("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x0b1020:s=640x360:r=30",
        "-vf",
        "drawbox=x=310:y=110:w=14:h=140:color=white:t=fill",
        "-t",
        "2",
        "-pix_fmt",
        "yuv420p",
        video,
      ]);
      expect(await detectBlack(video)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("still reports a genuinely black frame", async () => {
    if (!(await ffmpegAvailable())) return;
    const root = await mkdtemp(join(tmpdir(), "story-black-"));
    try {
      const video = join(root, "black.mp4");
      await execa("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x360:r=30",
        "-t",
        "2",
        "-pix_fmt",
        "yuv420p",
        video,
      ]);
      const intervals = await detectBlack(video);
      expect(intervals.length).toBeGreaterThan(0);
      expect(intervals[0].duration).toBeGreaterThan(1.5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execa("ffmpeg", ["-version"]);
    return true;
  } catch {
    console.warn("ffmpeg is not installed; skipping");
    return false;
  }
}

describe("render report severity", () => {
  const check = (
    name: string,
    passed: boolean,
    severity: "gate" | "warning",
  ) => ({ name, passed, detail: name, severity });

  it("a failed warning check does not fail the render report", () => {
    expect(
      gateChecksPassed([
        check("video_stream", true, "gate"),
        check("scene_1_shows_source", false, "warning"),
      ]),
    ).toBe(true);
  });

  it("a failed gate check still fails the render report", () => {
    expect(
      gateChecksPassed([
        check("video_stream", true, "gate"),
        check("duration_matches_audio", false, "gate"),
      ]),
    ).toBe(false);
  });
});
