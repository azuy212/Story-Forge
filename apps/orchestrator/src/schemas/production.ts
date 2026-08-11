import { z } from "zod";
import { VisualPlanEntrySchema } from "./visual-planner-output.js";
import { PromptQAOutputSchema } from "./prompt-qa-output.js";

export const ProviderEnum = z.enum([
  "gpt-image",
  "imagen",
  "flux",
  "runway",
  "veo",
  "manual",
]);

export const GenerationModeEnum = z.enum([
  "generate",
  "stock",
  "reuse",
  "upload",
]);

export const SceneTypeEnum = z.enum([
  "map",
  "landscape",
  "macro",
  "wildlife",
  "historical",
  "diagram",
  "comparison",
  "portrait",
  "timelapse",
  "infographic",
  "reconstruction",
  "animation",
]);

export const CameraShotEnum = z.enum([
  "wide",
  "medium",
  "close-up",
  "extreme-close",
  "aerial",
  "top-down",
  "isometric",
]);

export const CameraMotionEnum = z.enum([
  "static",
  "slow-pan",
  "push-in",
  "pull-back",
  "orbit",
  "drone-flyover",
  "parallax",
]);

export const TransitionEnum = z.enum([
  "cut",
  "fade",
  "cross-dissolve",
  "zoom",
  "match-cut",
]);

export const AssetTypeEnum = z.enum(["image", "video"]);

export const AssetModeEnum = z.enum([
  "generated",
  "source",
  "source_composite",
  "source_edit",
]);

export const SceneEntityTypeEnum = z.enum([
  "person",
  "place",
  "object",
  "organization",
  "product",
  "document",
  "landmark",
  "other",
]);

export const SceneEntitySchema = z.object({
  type: SceneEntityTypeEnum,
  name: z.string().min(1),
  canonicalId: z.string().optional(),
  requiresSourceImage: z.boolean().optional().default(false),
});

export const SourceAssetSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().optional(),
  url: z.string().url(),
  source: z.string().min(1),
  license: z.string().optional(),
  licenseUrl: z.string().url().optional(),
  attribution: z.string().optional(),
  sourcePageUrl: z.string().url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  title: z.string().optional(),
  localPath: z.string().optional(),
});

export const AssetKindEnum = z.enum([
  "source-image",
  "generated-image",
  "source-composite",
  "source-edit",
]);

export const SceneSchema = z.object({
  sceneId: z.number().int().positive(),
  startSecond: z.number().optional(),
  endSecond: z.number().optional(),
  durationSeconds: z.number().positive().optional(),
  narration: z.string().optional(),
  sceneGoal: z.string().optional(),
  visualDescription: z.string().optional(),
  sceneType: SceneTypeEnum.optional(),
  cameraShot: CameraShotEnum.optional(),
  cameraMotion: CameraMotionEnum.optional(),
  transition: TransitionEnum.optional(),
  emphasis: z.enum(["low", "medium", "high"]).optional(),
  emotionalBeat: z
    .enum([
      "mystery",
      "discovery",
      "tension",
      "awe",
      "relief",
      "payoff",
      "reflection",
    ])
    .optional(),
  assetType: AssetTypeEnum.optional(),
  assetMode: AssetModeEnum.optional(),
  assetKind: AssetKindEnum.optional(),
  entities: z.array(SceneEntitySchema).optional(),
  sourceAssetIds: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  generationPrompt: z.string().optional(),
  assetId: z.string().optional(),
  promptId: z.string().optional(),
  provider: ProviderEnum.optional(),
  generationMode: GenerationModeEnum.optional(),
  filename: z.string().optional(),
  extension: z.string().optional(),
  assetUrl: z.string().optional(),
  assetGeneratedAt: z.string().optional(),
});

export type Provider = z.input<typeof ProviderEnum>;
export type GenerationMode = z.input<typeof GenerationModeEnum>;
export type SceneType = z.input<typeof SceneTypeEnum>;
export type CameraShot = z.input<typeof CameraShotEnum>;
export type CameraMotion = z.input<typeof CameraMotionEnum>;
export type Transition = z.input<typeof TransitionEnum>;
export type AssetType = z.input<typeof AssetTypeEnum>;
export type AssetMode = z.input<typeof AssetModeEnum>;
export type SceneEntityType = z.input<typeof SceneEntityTypeEnum>;
export type SceneEntity = z.input<typeof SceneEntitySchema>;
export type SourceAsset = z.input<typeof SourceAssetSchema>;
export type AssetKind = z.input<typeof AssetKindEnum>;

export type Scene = z.input<typeof SceneSchema>;

export const DirectorReviewSchema = z.object({
  status: z.enum(["approved", "minor_revision"]),
  feedback: z.string(),
});

export const ProductionSchema = z.object({
  scenes: z.array(SceneSchema).optional(),
  plannedScenes: z.array(SceneSchema).optional(),
  sourceAssets: z.array(SourceAssetSchema).optional(),
  visualPlan: z.array(VisualPlanEntrySchema).optional(),
  promptQA: PromptQAOutputSchema.optional(),
  directorReview: DirectorReviewSchema.optional(),
});

export type Production = z.input<typeof ProductionSchema>;
export type DirectorReview = z.input<typeof DirectorReviewSchema>;
