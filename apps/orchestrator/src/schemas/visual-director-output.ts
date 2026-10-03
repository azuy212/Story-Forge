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
import { lenientEnum } from "./lenient-enum.js";

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

export const EMOTIONAL_BEATS = [
  "mystery",
  "discovery",
  "tension",
  "awe",
  "relief",
  "payoff",
  "reflection",
] as const;

export const EmotionalBeatEnum = lenientEnum(EMOTIONAL_BEATS, {
  // A neutral mid-story beat: unrecognized emotion words are downgraded to it
  // rather than failing the whole storyboard.
  fallback: "discovery",
  aliases: {
    suspense: "tension",
    suspenseful: "tension",
    tensionbuilding: "tension",
    "rising-tension": "tension",
    anticipation: "tension",
    anxious: "tension",
    wonder: "awe",
    amazement: "awe",
    astonishment: "awe",
    marvel: "awe",
    spectacular: "awe",
    inspiration: "awe",
    reveal: "discovery",
    realization: "discovery",
    epiphany: "discovery",
    insight: "discovery",
    breakthrough: "discovery",
    understanding: "discovery",
    curious: "mystery",
    curiosity: "mystery",
    question: "mystery",
    hook: "mystery",
    intrigue: "mystery",
    suspensehook: "mystery",
    comfort: "relief",
    calm: "relief",
    resolution: "relief",
    ease: "relief",
    climax: "payoff",
    conclusion: "payoff",
    culmination: "payoff",
    triumph: "payoff",
    emotionalpayoff: "payoff",
    contemplation: "reflection",
    reflective: "reflection",
    thoughtful: "reflection",
    closing: "reflection",
    coda: "reflection",
    takeaway: "reflection",
  },
});

const SceneRoleEnum = z.enum(["narrative", "b-roll"]);

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
  assetMode: AssetModeEnum,
  sceneRole: SceneRoleEnum,
  visualAnchor: z.string().optional(),
  entities: z.array(SceneEntitySchema).optional(),
  references: z.array(z.string()).optional(),
});

function buildScenesSchema(profile?: VideoProfileConfig) {
  const minScenes = profile?.profile === "long" ? 25 : 4;
  const maxScenes = profile?.profile === "long" ? null : 12;
  let arr = z
    .array(ScenePlanSchema)
    .min(minScenes, `must have at least ${minScenes} scenes`);
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

/**
 * Relaxed schema used only to recover a storyboard the strict schema rejected.
 *
 * Identical field shapes, but the scene-count band is dropped to a floor of
 * one. The strict band exists to steer the model toward the requested scene
 * density during a normal run; once every attempt has already failed there is
 * nothing left to steer, and a short-but-complete storyboard is a usable
 * "best available result" whereas no storyboard ends the run.
 *
 * Everything else stays strict — narration, visual description and the visual
 * plan entries are still required, so a recovered storyboard is structurally
 * sound. Only the count preference is given up.
 */
export function visualDirectorSalvageSchema() {
  return z.object({
    scenes: z.array(ScenePlanSchema).min(1, "must have at least one scene"),
    visualPlans: z
      .array(VisualPlanEntrySchema)
      .min(1, "must have at least one visual plan entry"),
  });
}

export const VisualDirectorSalvageSchema = visualDirectorSalvageSchema();

export type VisualDirectorOutput = z.output<typeof VisualDirectorOutputSchema>;
export type VisualPlanEntry = z.input<typeof VisualPlanEntrySchema>;
