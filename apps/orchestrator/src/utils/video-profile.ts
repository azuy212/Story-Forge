import { config } from "./config.js";
import { DEFAULT_PROFILES } from "../schemas/video-profile.js";
import type {
  VideoProfile,
  VideoProfileConfig,
} from "../schemas/video-profile.js";
import { wordCount } from "./narration-contract.js";

function wordsPerMinuteDefault(): number {
  return config.wordsPerMinute() ?? config.narrationTargetWpm() ?? 160;
}

export interface ResolveVideoProfileRequest {
  videoProfile?: VideoProfile;
  targetDurationSec?: number;
}

export interface ResolveVideoProfileOptions {
  wordsPerMinute?: number;
}

export function resolveVideoProfile(
  request: ResolveVideoProfileRequest,
  options: ResolveVideoProfileOptions = {},
): VideoProfileConfig {
  const explicit = !!(request.videoProfile || request.targetDurationSec);

  const profile = request.videoProfile ?? config.videoProfile() ?? "short";
  const base = { ...DEFAULT_PROFILES[profile] };

  // When explicit profile/target is requested, use profile defaults for all
  // other settings. Env vars only apply as global defaults when nothing is
  // explicitly requested.
  const targetDurationSec = explicit
    ? (request.targetDurationSec ?? base.targetDurationSec)
    : (request.targetDurationSec ??
      config.targetDurationSec() ??
      base.targetDurationSec);
  const durationToleranceSec = explicit
    ? base.durationToleranceSec
    : (config.durationToleranceSec() ?? base.durationToleranceSec);
  const wordsPerMinute = explicit
    ? (options.wordsPerMinute ?? wordsPerMinuteDefault())
    : (options.wordsPerMinute ??
      config.wordsPerMinute() ??
      wordsPerMinuteDefault());

  const aspectRatio = base.aspectRatio;
  const videoSize = base.videoSize;
  const thumbnailSize = base.thumbnailSize;

  const sceneDurationRange = base.sceneDurationRange;
  const sceneDensity = computeSceneDensity(
    targetDurationSec,
    sceneDurationRange,
    base.sceneDensity,
  );

  return {
    profile,
    targetDurationSec,
    durationToleranceSec,
    wordsPerMinute,
    sceneDurationRange,
    sceneDensity,
    aspectRatio,
    videoSize,
    thumbnailSize,
    explicit,
  };
}

function computeSceneDensity(
  targetDurationSec: number,
  sceneDurationRange: { min: number; max: number },
  profileBounds: { min: number; max: number | null },
): { min: number; max: number | null } {
  const minScenes = Math.ceil(targetDurationSec / sceneDurationRange.max);
  const maxScenes = Math.floor(targetDurationSec / sceneDurationRange.min);
  if (profileBounds.max === null) {
    return { min: Math.max(minScenes, profileBounds.min), max: null };
  }
  return {
    min: Math.max(minScenes, profileBounds.min),
    max: Math.min(maxScenes, profileBounds.max),
  };
}

const WORD_RANGE_FACTOR_MIN = 0.82;
const WORD_RANGE_FACTOR_MAX = 1.0;

export function wordRangeFor(profile: VideoProfileConfig): {
  min: number;
  max: number;
} {
  const targetWords = (profile.targetDurationSec / 60) * profile.wordsPerMinute;
  return {
    min: Math.round(targetWords * WORD_RANGE_FACTOR_MIN),
    max: Math.round(targetWords * WORD_RANGE_FACTOR_MAX),
  };
}

/**
 * Words per second of narration at the resolved speaking rate. This is
 * genuinely words-per-SECOND (wpm / 60); never call it a WPM value.
 */
export function speakingRateWordsPerSecond(
  profile: VideoProfileConfig,
): number {
  return profile.wordsPerMinute / 60;
}

export function checkNarrationDuration(
  profile: VideoProfileConfig,
  narration: string,
  estimatedDurationSeconds: number,
): string[] {
  const issues: string[] = [];

  const words = wordCount(narration);
  const wordRange = wordRangeFor(profile);

  // Long profile: only minimum word count; short profile: both min and max
  if (profile.profile === "long") {
    if (words < wordRange.min) {
      issues.push(
        `Narration word count ${words} below minimum ${wordRange.min} for ${profile.targetDurationSec}s target at ${profile.wordsPerMinute} wpm`,
      );
    }
  } else {
    if (words < wordRange.min || words > wordRange.max) {
      issues.push(
        `Narration word count ${words} outside expected range ${wordRange.min}-${wordRange.max} for ${profile.targetDurationSec}s target at ${profile.wordsPerMinute} wpm`,
      );
    }
  }

  // Long profile: only minimum duration; short profile: both min and max
  const minEstimated = profile.targetDurationSec - profile.durationToleranceSec;
  const maxEstimated = profile.targetDurationSec + profile.durationToleranceSec;
  if (profile.profile === "long") {
    if (estimatedDurationSeconds < minEstimated) {
      issues.push(
        `Estimated duration ${estimatedDurationSeconds}s below minimum ${minEstimated}s for ${profile.targetDurationSec}s target`,
      );
    }
  } else {
    if (
      estimatedDurationSeconds < minEstimated ||
      estimatedDurationSeconds > maxEstimated
    ) {
      issues.push(
        `Estimated duration ${estimatedDurationSeconds}s outside tolerance ${minEstimated}-${maxEstimated}s for ${profile.targetDurationSec}s target`,
      );
    }
  }

  return issues;
}

export function formatLabelFor(profile: VideoProfileConfig): string {
  if (profile.profile === "long") {
    return "long-form documentary video";
  }
  return "YouTube Short";
}

export function canvasGuidanceFor(profile: VideoProfileConfig): {
  aspectLabel: string;
  canvasGuidance: string;
  formatGuidance: string;
  aspectGuidance: string;
  formatLabel: string;
} {
  if (profile.profile === "long") {
    return {
      aspectLabel: "horizontal landscape 16:9",
      canvasGuidance: `Every generationPrompt must explicitly say "horizontal landscape 16:9" and describe a widescreen cinematic composition. Compose for a 1920x1080 canvas with the primary subject appropriately framed, keeping important details within safe margins.`,
      formatGuidance:
        'FORMAT — Does every image prompt explicitly request "horizontal landscape 16:9" and a widescreen cinematic composition? Reject prompts that request or imply vertical portrait, square, or tall framing.',
      aspectGuidance: "Output a horizontal 16:9 image at 1920x1080 pixels.",
      formatLabel: "long-form documentary video",
    };
  }
  return {
    aspectLabel: "vertical portrait 9:16",
    canvasGuidance: `Every generated image must be designed for a YouTube Shorts portrait canvas: explicitly include "vertical portrait 9:16" in the generationPrompt. Never request a landscape, square, wide, horizontal, or full-size image. Use portrait framing with the main subject large, centered, and readable on a phone screen.`,
    formatGuidance:
      'FORMAT — Does every image prompt explicitly request "vertical portrait 9:16" and a YouTube Shorts-style composition? Reject prompts that request or imply landscape, square, wide, horizontal, or full-size framing.',
    aspectGuidance: "Output a vertical 9:16 image at 1080x1920 pixels.",
    formatLabel: "YouTube Short",
  };
}
