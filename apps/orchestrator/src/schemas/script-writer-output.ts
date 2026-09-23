import { z } from "zod";
import {
  NarrativeEndingSchema,
  WriterBeatSchema,
  WriterRetentionSchema,
} from "./content.js";

function buildBeatsSchema() {
  return z
    .array(WriterBeatSchema)
    .min(1, "beats must not be empty")
    .superRefine((beats, ctx) => {
      beats.forEach((beat, index) => {
        if (beat.beatId !== index + 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "beatId"],
            message: `beatId must be sequential; expected ${index + 1}, received ${beat.beatId}`,
          });
        }
      });
    });
}

const ScriptWriterContentSchema = z.object({
  script: z.string().min(1, "script must not be empty"),
  // One narration entry per story-plan beat. The narration is assembled in
  // code from this array; the writer never emits a flat `narration` blob.
  beats: buildBeatsSchema(),
  retention: WriterRetentionSchema,
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
export type WriterRetention = z.input<typeof WriterRetentionSchema>;
export { WriterRetentionSchema };
