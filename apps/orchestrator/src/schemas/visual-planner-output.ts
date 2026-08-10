import { z } from "zod";

const RenderStyleEnum = z.enum([
  "photorealistic",
  "illustration",
  "3D",
  "satellite",
  "map",
  "diagram",
  "macro",
  "archive-style",
  "timelapse",
]);

export const VisualPlanEntrySchema = z.object({
  sceneId: z
    .number()
    .int("sceneId must be whole number")
    .positive("sceneId must be positive"),
  renderStyle: RenderStyleEnum,
  colorMood: z.string().min(1, "colorMood must not be empty"),
  lighting: z.string().min(1, "lighting must not be empty"),
  composition: z.string().min(1, "composition must not be empty"),
  visualNotes: z.string().optional(),
});

export type VisualPlanEntry = z.input<typeof VisualPlanEntrySchema>;
export type RenderStyle = z.input<typeof RenderStyleEnum>;
