import { z } from "zod";
import type { ArtifactType } from "./types.js";
import { ScriptPlannerOutputSchema } from "../schemas/script-planner-output.js";
import { ResearchOutputSchema } from "../schemas/research-output.js";
import { ResearchQAOutputSchema } from "../schemas/research-qa-output.js";
import { ScriptWriterOutputSchema } from "../schemas/script-writer-output.js";
import { ScriptQAOutputSchema } from "../schemas/script-qa-output.js";
import { MetadataOutputSchema } from "../schemas/metadata-output.js";
import { ThumbnailOutputSchema } from "../schemas/thumbnail-output.js";
import { VisualDirectorOutputSchema } from "../schemas/visual-director-output.js";
import { ImagePromptOutputSchema } from "../schemas/image-prompt-output.js";
import { PromptQAOutputSchema } from "../schemas/prompt-qa-output.js";
import { AudioSchema } from "../schemas/audio.js";
import { SubtitlesSchema } from "../schemas/subtitles.js";
import { VideoSchema } from "../schemas/video.js";
import { ReleaseValidationOutputSchema } from "../schemas/release-validation-output.js";
import { ProductionSchema } from "../schemas/production.js";
import { PublishingSchema } from "../schemas/publishing.js";

export interface ArtifactTypeDef {
  type: ArtifactType;
  schema: z.ZodTypeAny;
  node: string;
  description: string;
}

export const ARTIFACT_TYPES: ArtifactTypeDef[] = [
  { type: "scriptPlan", schema: ScriptPlannerOutputSchema, node: "ScriptPlanner", description: "Title, hook, and story outline" },
  { type: "research", schema: ResearchOutputSchema, node: "ResearchAgent", description: "Collected research summary and facts" },
  { type: "researchQA", schema: ResearchQAOutputSchema, node: "ResearchQA", description: "Research QA verdicts" },
  { type: "script", schema: ScriptWriterOutputSchema, node: "ScriptWriter", description: "Script, narration, CTA" },
  { type: "scriptQA", schema: ScriptQAOutputSchema, node: "ScriptQA", description: "Script QA review" },
  { type: "metadata", schema: MetadataOutputSchema, node: "MetadataGenerator", description: "Video metadata (title, desc, tags)" },
  { type: "thumbnail", schema: ThumbnailOutputSchema, node: "ThumbnailGenerator", description: "Thumbnail prompt" },
  { type: "visualDirector", schema: VisualDirectorOutputSchema, node: "VisualDirector", description: "Scene breakdown and visual style per scene" },
  { type: "prompts", schema: ImagePromptOutputSchema, node: "ImagePromptGenerator", description: "Generation prompts per scene" },
  { type: "promptQA", schema: PromptQAOutputSchema, node: "PromptQA", description: "Prompt QA review" },
  { type: "assets", schema: ProductionSchema, node: "AssetGenerator", description: "Generated asset URLs" },
  { type: "audio", schema: AudioSchema, node: "NarrationGenerator", description: "TTS audio metadata" },
  { type: "subtitles", schema: SubtitlesSchema, node: "SubtitleGenerator", description: "SRT/ASS subtitles with timestamps" },
  { type: "videoPlan", schema: VideoSchema, node: "VideoComposer", description: "Composed video metadata" },
  { type: "releaseValidation", schema: ReleaseValidationOutputSchema, node: "ReleaseValidation", description: "Deterministic release validation" },
  { type: "releaseReview", schema: ReleaseValidationOutputSchema, node: "ReleaseReview", description: "LLM release review" },
  { type: "publish", schema: PublishingSchema, node: "Publisher", description: "Publishing results" },
];

export function getArtifactDef(type: ArtifactType): ArtifactTypeDef | undefined {
  return ARTIFACT_TYPES.find((a) => a.type === type);
}

export function getArtifactDefByNode(node: string): ArtifactTypeDef | undefined {
  return ARTIFACT_TYPES.find((a) => a.node === node);
}

export function validateArtifact<T>(type: ArtifactType, data: T): T {
  const def = getArtifactDef(type);
  if (!def) return data;
  const result = def.schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Artifact validation failed for ${type}: ${result.error.issues.map(i => i.message).join("; ")}`);
  }
  return result.data as T;
}
