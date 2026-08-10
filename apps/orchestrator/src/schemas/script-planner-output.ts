import { z } from "zod";

const ScriptPlannerContentSchema = z.object({
  title: z
    .string()
    .min(1, "title must not be empty")
    .max(120, "title must not exceed 120 characters"),
  hook: z
    .string()
    .min(1, "hook must not be empty")
    .max(500, "hook must not exceed 500 characters"),
});

export const StoryTypeEnum = z.enum([
  "mystery",
  "debate",
  "discovery",
  "comparison",
  "explanation",
  "revelation",
]);

const ScriptBeatSchema = z.object({
  beatId: z
    .number()
    .int("beatId must be whole number")
    .positive("beatId must be positive"),
  purpose: z
    .string()
    .min(1, "purpose must not be empty"),
  viewerQuestion: z
    .string()
    .min(1, "viewerQuestion must not be empty"),
  curiosityQuestion: z
    .string()
    .min(1, "curiosityQuestion must not be empty"),
  keyMessage: z
    .string()
    .min(1, "keyMessage must not be empty"),
  referencedFacts: z
    .array(z.string())
    .min(1, "every beat must reference at least one fact"),
  priority: z.enum(["high", "medium", "low"]),
  estimatedDurationSeconds: z
    .number()
    .positive("estimatedDurationSeconds must be positive"),
});

export const ScriptPlannerOutputSchema = z.object({
  content: ScriptPlannerContentSchema,
  storyType: StoryTypeEnum,
  storySummary: z
    .string()
    .min(1, "storySummary must not be empty"),
  storyBeats: z
    .array(ScriptBeatSchema)
    .min(6, "must have at least 6 story beats")
    .max(10, "must have at most 10 story beats"),
});

export type ScriptPlannerOutput = z.input<typeof ScriptPlannerOutputSchema>;
export type StoryType = z.input<typeof StoryTypeEnum>;
