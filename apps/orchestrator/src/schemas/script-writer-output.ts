import { z } from "zod";
import { NarrativeEndingSchema } from "./content.js";

const ScriptWriterContentSchema = z.object({
  script: z.string().min(1, "script must not be empty"),
  narration: z.string().min(1, "narration must not be empty"),
  callToAction: z.string().min(1, "callToAction must not be empty").optional(),
  estimatedDurationSeconds: z
    .number()
    .int("duration must be whole number")
    .positive("duration must be positive"),
  // Optional for cached/legacy model responses. Current prompt requires it.
  ending: NarrativeEndingSchema.optional(),
});

export const ScriptWriterOutputSchema = z.object({
  content: ScriptWriterContentSchema,
});

export type ScriptWriterOutput = z.input<typeof ScriptWriterOutputSchema>;
