import { config } from "./config.js";
import { DEFAULT_PROFILES } from "../schemas/video-profile.js";
import type {
  VideoProfile,
  VideoProfileConfig,
} from "../schemas/video-profile.js";

function wordsPerMinuteDefault(): number {
  return config.narrationTargetWpm() ?? 160;
}

function envVideoProfile(): VideoProfile | undefined {
  const value = process.env.VIDEO_PROFILE;
  if (value === "short" || value === "long") return value;
  return undefined;
}

function envTargetDurationSec(): number | undefined {
  const value = process.env.TARGET_DURATION_SEC;
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function envDurationToleranceSec(): number | undefined {
  const value = process.env.DURATION_TOLERANCE_SEC;
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function envWordsPerMinute(): number | undefined {
  const value = process.env.WORDS_PER_MINUTE;
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

  const profile = request.videoProfile ?? envVideoProfile() ?? "short";
  const base = { ...DEFAULT_PROFILES[profile] };

  // When explicit profile/target is requested, use profile defaults for all
  // other settings. Env vars only apply as global defaults when nothing is
  // explicitly requested.
  const targetDurationSec = explicit
    ? request.targetDurationSec ?? base.targetDurationSec
    : request.targetDurationSec ?? envTargetDurationSec() ?? base.targetDurationSec;
  const durationToleranceSec = explicit
    ? base.durationToleranceSec
    : envDurationToleranceSec() ?? base.durationToleranceSec;
  const wordsPerMinute = explicit
    ? options.wordsPerMinute ?? wordsPerMinuteDefault() ?? base.wordsPerMinute
    : options.wordsPerMinute ?? envWordsPerMinute() ?? wordsPerMinuteDefault() ?? base.wordsPerMinute;

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
  profileBounds: { min: number; max: number },
): { min: number; max: number } {
  const minScenes = Math.ceil(targetDurationSec / sceneDurationRange.max);
  const maxScenes = Math.floor(targetDurationSec / sceneDurationRange.min);
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

export function speakingRateWps(profile: VideoProfileConfig): number {
  return profile.wordsPerMinute / 60;
}

export function checkNarrationDuration(
  profile: VideoProfileConfig,
  narration: string,
  estimatedDurationSeconds: number,
): string[] {
  const issues: string[] = [];

  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  const wordRange = wordRangeFor(profile);

  if (words < wordRange.min || words > wordRange.max) {
    issues.push(
      `Narration word count ${words} outside expected range ${wordRange.min}-${wordRange.max} for ${profile.targetDurationSec}s target at ${profile.wordsPerMinute} wpm`,
    );
  }

  const minEstimated = profile.targetDurationSec - profile.durationToleranceSec;
  const maxEstimated = profile.targetDurationSec + profile.durationToleranceSec;
  if (
    estimatedDurationSeconds < minEstimated ||
    estimatedDurationSeconds > maxEstimated
  ) {
    issues.push(
      `Estimated duration ${estimatedDurationSeconds}s outside tolerance ${minEstimated}-${maxEstimated}s for ${profile.targetDurationSec}s target`,
    );
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
