import { z } from "zod";
import type { VideoProfileConfig } from "./video-profile.js";

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
  purpose: z.string().min(1, "purpose must not be empty"),
  viewerQuestion: z.string().min(1, "viewerQuestion must not be empty"),
  curiosityQuestion: z.string().min(1, "curiosityQuestion must not be empty"),
  keyMessage: z.string().min(1, "keyMessage must not be empty"),
  referencedFacts: z
    .array(z.string())
    .min(1, "every beat must reference at least one fact"),
  priority: z.enum(["high", "medium", "low"]),
  estimatedDurationSeconds: z
    .number()
    .positive("estimatedDurationSeconds must be positive"),
});

function buildScriptBeatsSchema(profile?: VideoProfileConfig) {
  const minBeats = profile?.profile === "long" ? 10 : 6;
  const maxBeats = profile?.profile === "long" ? 18 : 10;
  return z
    .array(ScriptBeatSchema)
    .min(minBeats, `must have at least ${minBeats} story beats`)
    .max(maxBeats, `must have at most ${maxBeats} story beats`)
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

export function scriptPlannerOutputSchema(profile?: VideoProfileConfig) {
  return z.object({
    content: ScriptPlannerContentSchema,
    storyType: StoryTypeEnum,
    storySummary: z.string().min(1, "storySummary must not be empty"),
    storyBeats: buildScriptBeatsSchema(profile),
  });
}

export const ScriptPlannerOutputSchema = scriptPlannerOutputSchema();

export type ScriptPlannerOutput = z.input<typeof ScriptPlannerOutputSchema>;
export type StoryType = z.input<typeof StoryTypeEnum>;
