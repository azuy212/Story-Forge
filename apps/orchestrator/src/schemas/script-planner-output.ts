import { z } from "zod";
import type { VideoProfileConfig } from "./video-profile.js";
import { NarrativeEndingTypeEnum } from "./content.js";
import { wordRangeFor } from "../utils/video-profile.js";

export const AudienceTriggerTypeEnum = z.enum([
  "curiosity",
  "surprise",
  "shock",
  "past-belief-challenge",
  "fear",
  "greed",
  "insecurity",
  "documentary-explanation",
]);

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

const AudienceTriggerSchema = z.object({
  type: AudienceTriggerTypeEnum,
  statement: z.string().min(1, "audienceTrigger.statement must not be empty"),
  factIds: z
    .array(z.string())
    .min(1, "audienceTrigger must reference at least one fact"),
});

const RetentionSchema = z.object({
  pivotBeatId: z
    .number()
    .int("pivotBeatId must be whole number")
    .positive("pivotBeatId must be positive"),
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
  targetWords: z
    .number()
    .int("targetWords must be whole number")
    .positive("targetWords must be positive"),
  estimatedDurationSeconds: z
    .number()
    .positive("estimatedDurationSeconds must be positive"),
});

function buildScriptBeatsSchema(profile?: VideoProfileConfig) {
  const minBeats = profile?.profile === "long" ? 10 : 6;
  const maxBeats = profile?.profile === "long" ? null : 10;
  let arr = z
    .array(ScriptBeatSchema)
    .min(minBeats, `must have at least ${minBeats} story beats`);
  if (maxBeats !== null) {
    arr = arr.max(maxBeats, `must have at most ${maxBeats} story beats`);
  }
  return arr.superRefine((beats, ctx) => {
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

export function beatCountRangeFor(profile?: VideoProfileConfig): {
  min: number;
  max: number | null;
} {
  if (profile?.profile === "long") return { min: 10, max: null };
  return { min: 6, max: 10 };
}

export function scriptPlannerOutputSchema(profile?: VideoProfileConfig) {
  const wordRange = profile ? wordRangeFor(profile) : null;
  return z
    .object({
      content: ScriptPlannerContentSchema,
      storyType: StoryTypeEnum,
      storySummary: z.string().min(1, "storySummary must not be empty"),
      storyBeats: buildScriptBeatsSchema(profile),
      audienceTrigger: AudienceTriggerSchema,
      endingType: NarrativeEndingTypeEnum,
      retention: RetentionSchema,
    })
    .superRefine((data, ctx) => {
      if (data.retention.pivotBeatId > data.storyBeats.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retention", "pivotBeatId"],
          message: `retention.pivotBeatId must reference an existing beat; expected <= ${data.storyBeats.length}, received ${data.retention.pivotBeatId}`,
        });
      }

      if (wordRange) {
        const sum = data.storyBeats.reduce(
          (total, beat) => total + beat.targetWords,
          0,
        );
        if (sum < wordRange.min || sum > wordRange.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["storyBeats"],
            message: `sum of targetWords (${sum}) must land within the narration word range ${wordRange.min}-${wordRange.max} for the ${profile?.targetDurationSec}s target`,
          });
        }
      }

      // Trigger references must be traceable to a beat. Otherwise the
      // audience trigger has no narrated moment and the pipeline cannot
      // deterministically deliver it.
      const referencedFactIds = new Set(
        data.storyBeats.flatMap((beat) => beat.referencedFacts),
      );
      for (const factId of data.audienceTrigger.factIds ?? []) {
        if (!referencedFactIds.has(factId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["audienceTrigger", "factIds"],
            message: `audienceTrigger references fact "${factId}" which no beat references`,
          });
        }
      }
    });
}

export const ScriptPlannerOutputSchema = scriptPlannerOutputSchema();

export type ScriptPlannerOutput = z.input<typeof ScriptPlannerOutputSchema>;
export type StoryType = z.input<typeof StoryTypeEnum>;
export type AudienceTriggerType = z.input<typeof AudienceTriggerTypeEnum>;
export type AudienceTrigger = z.input<typeof AudienceTriggerSchema>;
export type Retention = z.input<typeof RetentionSchema>;
