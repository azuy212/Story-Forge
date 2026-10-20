import { config } from "../utils/config.js";
import type { ResolvedStoryConfig } from "./types.js";

/** Command-line overrides applied on top of the STORY_* environment defaults. */
export interface StoryCliOverrides {
  topic?: string;
  duration?: number;
  language?: string;
  tone?: string;
  style?: string;
  jobId?: string;
  outputDir?: string;
  wpm?: number;
  fps?: number;
  resolution?: string;
  imageConcurrency?: number;
  sceneGapMs?: number;
}

/**
 * The keys a CLI is allowed to override. Exported so `scripts/story-video.mjs`
 * can reject an unknown key at startup instead of silently ignoring a flag
 * (which is how `--duration` once did nothing: the script wrote
 * `targetDurationSec`, this contract reads `duration`).
 */
export const STORY_CLI_OVERRIDE_KEYS = [
  "topic",
  "duration",
  "language",
  "tone",
  "style",
  "jobId",
  "outputDir",
  "wpm",
  "fps",
  "resolution",
  "imageConcurrency",
  "sceneGapMs",
] as const satisfies readonly (keyof StoryCliOverrides)[];

export function parseResolution(
  value: string,
  fallback = { width: 1920, height: 1080 },
): { width: number; height: number } {
  const match = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/i.exec(value.trim());
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return fallback;
  }
  return { width, height };
}

/**
 * Resolve the story job configuration. Precedence: CLI override → STORY_*
 * env → built-in default. This function is the ONLY reader of story config,
 * so a Shorts-pipeline variable (e.g. NARRATION_GENERATION_MODE,
 * TARGET_DURATION_SEC) can never leak into story mode.
 */
export function resolveStoryConfig(
  cli: StoryCliOverrides = {},
): ResolvedStoryConfig {
  const resolution = parseResolution(
    cli.resolution ?? config.storyResolution(),
  );
  const targetDurationSec = cli.duration ?? config.storyTargetDurationSec();
  return {
    topic: (cli.topic ?? "").trim(),
    targetDurationSec,
    language: (cli.language ?? config.storyLanguage()).trim(),
    tone: cli.tone ?? config.storyTone(),
    style: cli.style ?? config.storyStyle(),
    jobId: cli.jobId ?? "",
    outputDir: cli.outputDir,
    wpm: cli.wpm ?? config.storyTtsWpm(),
    imageConcurrency: cli.imageConcurrency ?? config.storyImageConcurrency(),
    sceneMinSec: config.storySceneMinSec(),
    sceneTargetMinSec: config.storySceneTargetMinSec(),
    sceneTargetMaxSec: config.storySceneTargetMaxSec(),
    sceneSoftMaxSec: config.storySceneSoftMaxSec(),
    width: resolution.width,
    height: resolution.height,
    fps: cli.fps ?? config.storyFps(),
    sceneGapMs: cli.sceneGapMs ?? config.storySceneGapMs(),
    imageMinWidth: config.storyImageMinWidth(),
    imageMinHeight: config.storyImageMinHeight(),
    imageMinAspect: config.storyImageMinAspect(),
    imageMaxAspect: config.storyImageMaxAspect(),
    ttsMaxChars: config.storyTtsMaxChars(),
    asrVerify: config.storyAsrVerify(),
    subtitleMaxCharsPerLine: config.storySubtitleMaxCharsPerLine(),
    subtitleMinDurationMs: config.storySubtitleMinDurationMs(),
    crf: config.storyCrf(),
    preset: config.storyPreset(),
  };
}

/**
 * Story mode is always per-scene chunked TTS (DP1). Exposed as an explicit
 * constant — rather than reading `config.narrationGenerationMode()` — so a
 * `NARRATION_GENERATION_MODE=complete` set for the Shorts pipeline can never
 * change story behaviour, and that isolation is directly testable.
 */
export function storyTtsMode(): "scene" {
  return "scene";
}
