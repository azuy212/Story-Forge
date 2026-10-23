import { hashObject } from "../artifacts/hash.js";
import { PipelineError } from "../utils/errors.js";
import { slugify } from "../utils/slugify.js";
import type { ResolvedStoryConfig } from "./types.js";

/** BCP-47-ish language tag: `en`, `en-US`, `ur`, `zh-Hans`. */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface StoryInputIssue {
  field: string;
  message: string;
}

/**
 * Validate the job input before anything is created or any paid call is made.
 * Fail fast with actionable messages (brief S1).
 */
export function validateStoryInput(
  config: ResolvedStoryConfig,
): StoryInputIssue[] {
  const issues: StoryInputIssue[] = [];

  if (!config.topic) {
    issues.push({ field: "topic", message: "topic must not be empty" });
  } else if (config.topic.length > 500) {
    issues.push({
      field: "topic",
      message: "topic must be 500 characters or fewer",
    });
  }

  if (
    !Number.isFinite(config.targetDurationSec) ||
    config.targetDurationSec <= 0
  ) {
    issues.push({
      field: "targetDurationSec",
      message: "targetDurationSec must be a positive number of seconds",
    });
  } else if (config.targetDurationSec < 10) {
    issues.push({
      field: "targetDurationSec",
      message:
        "targetDurationSec must be at least 10 seconds (the pipeline needs at least one scene)",
    });
  }

  if (!LANGUAGE_TAG.test(config.language)) {
    issues.push({
      field: "language",
      message: `unsupported language tag "${config.language}" (expected a BCP-47 tag such as "en" or "ur")`,
    });
  }

  if (!config.style) {
    issues.push({ field: "style", message: "style must not be empty" });
  }

  if (!Number.isFinite(config.wpm) || config.wpm <= 0) {
    issues.push({ field: "wpm", message: "wpm must be a positive number" });
  }

  if (!Number.isInteger(config.fps) || config.fps <= 0) {
    issues.push({ field: "fps", message: "fps must be a positive integer" });
  }

  if (config.imageMinAspect >= config.imageMaxAspect) {
    issues.push({
      field: "imageAspect",
      message: "imageMinAspect must be smaller than imageMaxAspect",
    });
  }

  return issues;
}

/** Throw a single actionable PipelineError listing every input issue. */
export function assertStoryInput(config: ResolvedStoryConfig): void {
  const issues = validateStoryInput(config);
  if (issues.length === 0) return;
  throw new PipelineError(
    `Invalid story job input: ${issues
      .map((issue) => `${issue.field}: ${issue.message}`)
      .join("; ")}`,
    "STORY_INPUT_INVALID",
  );
}

/**
 * Deterministic default job id: slug of the topic plus a short hash of the
 * configuration that shapes the job, so re-running the same topic resumes the
 * same directory instead of starting a new one.
 */
export function deriveJobId(config: ResolvedStoryConfig): string {
  if (config.jobId) return config.jobId;
  const hash = hashObject({
    topic: config.topic,
    targetDurationSec: config.targetDurationSec,
    language: config.language,
    tone: config.tone ?? null,
    style: config.style,
  }).slice(0, 8);
  return `${slugify(config.topic).slice(0, 60)}-${hash}`;
}
