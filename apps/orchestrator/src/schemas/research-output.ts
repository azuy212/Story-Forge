import { z } from "zod";
import { FactClassificationEnum } from "./research.js";

export const ResearchOutputSchema = z.object({
  summary: z.string().min(1, "summary must not be empty"),
  facts: z
    .array(
      z.object({
        id: z.string(),
        fact: z.string().min(1, "fact must not be empty"),
        confidence: z.enum(["high", "medium", "low"]),
        sourceType: z.enum(["general-knowledge"]),
        classification: FactClassificationEnum.optional(),
        verified: z.boolean().optional(),
        reason: z.string().optional(),
      }),
    )
    .min(8, "must have at least 8 facts")
    .max(20, "must have at most 20 facts"),
});

export type ResearchOutput = z.input<typeof ResearchOutputSchema>;
