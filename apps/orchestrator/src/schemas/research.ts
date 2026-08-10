import { z } from "zod";

export const FactClassificationEnum = z.enum([
  "verified",
  "likely",
  "debated",
  "popular_theory",
  "unverified_claim",
  "myth",
  "false",
]);

export const ResearchSchema = z.object({
  summary: z.string().optional(),
  facts: z
    .array(
      z.object({
        id: z.string(),
        fact: z.string(),
        confidence: z.enum(["high", "medium", "low"]),
        sourceType: z.enum(["general-knowledge"]),
        classification: FactClassificationEnum.optional(),
        verified: z.boolean().optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
});

export type Research = z.input<typeof ResearchSchema>;
export type FactClassification = z.input<typeof FactClassificationEnum>;
