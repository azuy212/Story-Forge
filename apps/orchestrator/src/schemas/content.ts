import { z } from "zod";

// The writer declares ONLY the pivot sentence. Hook, ending, pivot word
// position, pivot→beat containment, and per-beat budgets are all derived
// deterministically by `checkScriptContract`.
export const WriterRetentionSchema = z.object({
  pivotSentence: z.string().min(1, "pivotSentence must not be empty"),
});

// One narration beat per story-plan beat. The writer contract requires a
// strict 1:1 mapping: ids sequential from 1 with one beat per planner beat.
export const WriterBeatSchema = z.object({
  beatId: z
    .number()
    .int("beatId must be whole number")
    .positive("beatId must be positive"),
  narration: z.string().min(1, "beat narration must not be empty"),
});

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
  retention: WriterRetentionSchema.optional(),
  beats: z.array(WriterBeatSchema).optional(),
});

export type Content = z.input<typeof ContentSchema>;
export type NarrativeEnding = z.input<typeof NarrativeEndingSchema>;
export type NarrativeEndingType = z.input<typeof NarrativeEndingTypeEnum>;
export type WriterRetention = z.input<typeof WriterRetentionSchema>;
export type WriterBeat = z.input<typeof WriterBeatSchema>;
