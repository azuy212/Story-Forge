import { z } from "zod";
import type { VideoProfileConfig } from "./video-profile.js";
import {
  SceneTypeEnum,
  CameraShotEnum,
  CameraMotionEnum,
  TransitionEnum,
  AssetTypeEnum,
  AssetModeEnum,
  SceneEntitySchema,
} from "./production.js";
import { VisualPlanEntrySchema } from "./visual-planner-output.js";

const EmphasisEnum = z.enum(["low", "medium", "high"]);

const CAMERA_SHOT_ALIASES: Record<string, z.infer<typeof CameraShotEnum>> = {
  establishing: "wide",
  "establishing-shot": "wide",
  "long-shot": "wide",
  "medium-shot": "medium",
  "medium-wide": "medium",
  closeup: "close-up",
  "close-up-shot": "close-up",
  "extreme-close-up": "extreme-close",
  "bird-eye": "top-down",
  birdseye: "top-down",
  "bird's-eye": "top-down",
  overhead: "top-down",
  "isometric-view": "isometric",
};

const CameraShotInput = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return CAMERA_SHOT_ALIASES[normalized] ?? value;
}, CameraShotEnum);

export const EmotionalBeatEnum = z.enum([
  "mystery",
  "discovery",
  "tension",
  "awe",
  "relief",
  "payoff",
  "reflection",
]);

const ScenePlanSchema = z.object({
  sceneId: z
    .number()
    .int("sceneId must be whole number")
    .positive("sceneId must be positive"),
  narration: z.string().min(1, "narration must not be empty"),
  sceneGoal: z.string().min(1, "sceneGoal must not be empty"),
  visualDescription: z.string().min(1, "visualDescription must not be empty"),
  sceneType: SceneTypeEnum,
  cameraShot: CameraShotInput,
  cameraMotion: CameraMotionEnum,
  transition: TransitionEnum,
  emphasis: EmphasisEnum.optional(),
  emotionalBeat: EmotionalBeatEnum,
  assetType: AssetTypeEnum.optional(),
  assetMode: AssetModeEnum.optional(),
  entities: z.array(SceneEntitySchema).optional(),
  references: z.array(z.string()).optional(),
});

function buildScenesSchema(profile?: VideoProfileConfig) {
  const minScenes = profile?.profile === "long" ? 25 : 4;
  const maxScenes = profile?.profile === "long" ? null : 12;
  let arr = z.array(ScenePlanSchema).min(minScenes, `must have at least ${minScenes} scenes`);
  if (maxScenes !== null) {
    arr = arr.max(maxScenes, `must have at most ${maxScenes} scenes`);
  }
  return arr;
}

export function visualDirectorOutputSchema(profile?: VideoProfileConfig) {
  return z.object({
    scenes: buildScenesSchema(profile),
    visualPlans: z
      .array(VisualPlanEntrySchema)
      .min(1, "must have at least one visual plan entry"),
  });
}

export const VisualDirectorOutputSchema = visualDirectorOutputSchema();

export type VisualDirectorOutput = z.output<typeof VisualDirectorOutputSchema>;
export type VisualPlanEntry = z.input<typeof VisualPlanEntrySchema>;
