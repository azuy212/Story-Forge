import { z } from "zod";

export const VideoProfileEnum = z.enum(["short", "long"]);
export type VideoProfile = z.input<typeof VideoProfileEnum>;

export const AspectRatioEnum = z.enum(["9:16", "16:9"]);
export type AspectRatio = z.input<typeof AspectRatioEnum>;

export const VideoSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type VideoSize = z.input<typeof VideoSizeSchema>;

export const SceneDurationRangeSchema = z.object({
  min: z.number().positive(),
  max: z.number().positive(),
});
export type SceneDurationRange = z.input<typeof SceneDurationRangeSchema>;

export const SceneDensitySchema = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive().nullable(),
});
export type SceneDensity = z.input<typeof SceneDensitySchema>;

export const VideoProfileConfigSchema = z.object({
  profile: VideoProfileEnum,
  targetDurationSec: z.number().positive(),
  durationToleranceSec: z.number().nonnegative(),
  wordsPerMinute: z.number().positive(),
  sceneDurationRange: SceneDurationRangeSchema,
  sceneDensity: SceneDensitySchema,
  aspectRatio: AspectRatioEnum,
  videoSize: VideoSizeSchema,
  thumbnailSize: VideoSizeSchema,
  explicit: z.boolean(),
});
export type VideoProfileConfig = z.input<typeof VideoProfileConfigSchema>;

export const DEFAULT_PROFILES: Record<
  VideoProfile,
  Omit<VideoProfileConfig, "explicit">
> = {
  short: {
    profile: "short",
    targetDurationSec: 50,
    durationToleranceSec: 25,
    wordsPerMinute: 160,
    sceneDurationRange: { min: 4, max: 8 },
    sceneDensity: { min: 6, max: 10 },
    aspectRatio: "9:16",
    videoSize: { width: 1080, height: 1920 },
    thumbnailSize: { width: 1080, height: 1920 },
  },
  long: {
    profile: "long",
    targetDurationSec: 300,
    durationToleranceSec: 45,
    wordsPerMinute: 160,
    sceneDurationRange: { min: 7, max: 12 },
    sceneDensity: { min: 25, max: null },
    aspectRatio: "16:9",
    videoSize: { width: 1920, height: 1080 },
    thumbnailSize: { width: 1280, height: 720 },
  },
};
