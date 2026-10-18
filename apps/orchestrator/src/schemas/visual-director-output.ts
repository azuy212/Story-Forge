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

/**
 * Interior scene shape shared by the model-facing and derived variants. The
 * model lists `unitIds` (the narration units the scene covers) and never
 * writes narration text — the narration is derived by joining the units, and
 * the narrative ending check runs against narration tokens outside the model
 * schema.
 */
const ScenePlanSharedSchema = z.object({
  sceneId: z
    .number()
    .int("sceneId must be whole number")
    .positive("sceneId must be positive"),
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
  // Optional so visual plans cached before scene→beat traceability landed
  // still validate on resume. PromptQA flags a story beat no scene covers.
  sourceBeatIds: z.array(z.number().int()).optional(),
  entities: z.array(SceneEntitySchema).optional(),
  references: z.array(z.string()).optional(),
});

/** Scene exactly as the model returns it: unit ids, no narration text. */
const ScenePlanInputSchema = ScenePlanSharedSchema.extend({
  unitIds: z
    .array(
      z
        .number()
        .int("unitIds must be whole numbers")
        .min(1, "unit ids must be at least 1"),
    )
    .min(1, "unitIds must not be empty"),
});

/** Stored/derived scene: the narration the system joined from those units. */
const ScenePlanSchema = ScenePlanSharedSchema.extend({
  unitIds: z
    .array(
      z
        .number()
        .int("unitIds must be whole numbers")
        .min(1, "unit ids must be at least 1"),
    )
    .min(1, "unitIds must not be empty"),
  narration: z.string().min(1, "narration must not be empty"),
  /**
   * Bookkeeping from `finalizeSceneUnits` (not written by the model): every
   * model-origin scene id this produced scene represents — a split piece
   * shares its parent's id, a scene folded into a neighbour inherits its ids.
   * Visual plans use it to follow the scenes they originally described.
   */
  modelSceneIds: z.array(z.number().int()).optional(),
});

export interface SceneCountBand {
  minScenes: number;
  maxScenes: number | null;
}

export function sceneCountBand(profile?: VideoProfileConfig): SceneCountBand {
  const minScenes = profile?.profile === "long" ? 25 : 4;
  const maxScenes = profile?.profile === "long" ? null : 12;
  return { minScenes, maxScenes };
}

function buildScenesSchema<T extends z.ZodTypeAny>(
  scene: T,
  profile?: VideoProfileConfig,
): z.ZodArray<T> {
  const { minScenes, maxScenes } = sceneCountBand(profile);
  let arr = z
    .array(scene)
    .min(minScenes, `must have at least ${minScenes} scenes`);
  if (maxScenes !== null) {
    arr = arr.max(maxScenes, `must have at most ${maxScenes} scenes`);
  }
  return arr;
}

/**
 * The model-facing schema: scenes carry `unitIds` only. Narration is derived
 * afterward by `finalizeSceneUnits` inside the node's postProcess hook.
 */
export function visualDirectorUnitOutputSchema(profile?: VideoProfileConfig) {
  return z.object({
    scenes: buildScenesSchema(ScenePlanInputSchema, profile),
    visualPlans: z
      .array(VisualPlanEntrySchema)
      .min(1, "must have at least one visual plan entry"),
  });
}

/** The derived/stored schema — narration present alongside `unitIds`. */
export function visualDirectorOutputSchema(profile?: VideoProfileConfig) {
  return z.object({
    scenes: buildScenesSchema(ScenePlanSchema, profile),
    visualPlans: z
      .array(VisualPlanEntrySchema)
      .min(1, "must have at least one visual plan entry"),
  });
}

export const VisualDirectorOutputSchema = visualDirectorOutputSchema();

export type VisualDirectorUnitOutput = z.output<
  ReturnType<typeof visualDirectorUnitOutputSchema>
>;

/**
 * Relaxed schema used only to recover a storyboard the strict schema rejected.
 *
 * Identical field shapes, but the scene-count band is dropped to a floor of
 * one. The strict band exists to steer the model toward the requested scene
 * density during a normal run; once every attempt has already failed there is
 * nothing left to steer, and a short-but-complete storyboard is a usable
 * "best available result" whereas no storyboard ends the run.
 *
 * Model shape (unit ids, no narration) — the caller derives narration through
 * the same `finalizeSceneUnits` path used for cleanly validated responses.
 */
export function visualDirectorSalvageSchema() {
  return z.object({
    scenes: z
      .array(ScenePlanInputSchema)
      .min(1, "must have at least one scene"),
    visualPlans: z
      .array(VisualPlanEntrySchema)
      .min(1, "must have at least one visual plan entry"),
  });
}

export const VisualDirectorSalvageSchema = visualDirectorSalvageSchema();

export type VisualDirectorOutput = z.output<typeof VisualDirectorOutputSchema>;
export type VisualPlanEntry = z.input<typeof VisualPlanEntrySchema>;
