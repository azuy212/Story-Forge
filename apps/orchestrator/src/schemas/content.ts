import { z } from "zod";

export const NarrativeEndingTypeEnum = z.enum([
  "revelation",
  "twist",
  "callback",
  "unresolved_mystery",
  "open_question",
  "surprising_implication",
]);

export const NarrativeEndingSchema = z.object({
  type: NarrativeEndingTypeEnum,
  narration: z.string().min(1, "ending narration must not be empty"),
  visualDirection: z.string().optional(),
});

export const ContentSchema = z.object({
  title: z.string().optional(),
  hook: z.string().optional(),
  script: z.string().optional(),
  narration: z.string().optional(),
  callToAction: z.string().optional(),
  estimatedDurationSeconds: z.number().int().positive().optional(),
  ending: NarrativeEndingSchema.optional(),
});

export type Content = z.input<typeof ContentSchema>;
export type NarrativeEnding = z.input<typeof NarrativeEndingSchema>;
export type NarrativeEndingType = z.input<typeof NarrativeEndingTypeEnum>;
