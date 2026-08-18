import { z } from "zod";
import { ProjectSchema } from "./project.js";
import { ContentSchema } from "./content.js";
import { ResearchSchema } from "./research.js";
import { ProductionSchema } from "./production.js";
import { ScriptPlannerOutputSchema } from "./script-planner-output.js";
import { ScriptQAOutputSchema } from "./script-qa-output.js";
import { BrandingSchema } from "./branding.js";
import { DiagnosticsSchema } from "./diagnostics.js";
import { ExecutionSchema } from "./execution.js";
import { AudioSchema } from "./audio.js";
import { SubtitlesSchema } from "./subtitles.js";
import { VideoSchema } from "./video.js";
import { ReleaseValidationOutputSchema } from "./release-validation-output.js";
import { MetadataOutputSchema } from "./metadata-output.js";
import { ThumbnailSchema } from "./thumbnail.js";
import { PublishingSchema } from "./publishing.js";
import { ResearchQAOutputSchema } from "./research-qa-output.js";
import { DEFAULT_BRANDING } from "../utils/branding.js";
export const ProjectStateSchema = z.object({
  project: ProjectSchema,
  content: ContentSchema.optional().default({}),
  research: ResearchSchema.optional().default({}),
  storyPlan: ScriptPlannerOutputSchema.optional().default({
    content: { title: "", hook: "" },
    storyType: "mystery",
    storySummary: "",
    storyBeats: [],
  }),
  scriptQA: ScriptQAOutputSchema.optional(),
  production: ProductionSchema.optional().default({ scenes: [] }),
  branding: BrandingSchema.optional().default(DEFAULT_BRANDING),
  diagnostics: DiagnosticsSchema.optional().default({
    errors: [],
    warnings: [],
    scores: {},
    telemetry: {},
  }),
  audio: AudioSchema.optional().default({}),
  subtitles: SubtitlesSchema.optional().default({}),
  video: VideoSchema.optional().default({}),
  releaseValidation: ReleaseValidationOutputSchema.optional(),
  releaseReview: ReleaseValidationOutputSchema.optional(),
  researchQA: ResearchQAOutputSchema.optional(),
  metadataOutput: MetadataOutputSchema.optional(),
  thumbnail: ThumbnailSchema.optional().default({}),
  publishing: PublishingSchema.optional().default({}),
  execution: ExecutionSchema,
});

export type ProjectState = z.input<typeof ProjectStateSchema>;
export type ProjectStateOutput = z.output<typeof ProjectStateSchema>;
