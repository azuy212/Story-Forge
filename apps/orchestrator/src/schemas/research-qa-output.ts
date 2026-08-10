import { z } from "zod";
import { FactClassificationEnum } from "./research.js";

const FactVerdictSchema = z.object({
  factId: z.string().min(1),
  verdict: z.enum(["keep", "remove", "revise"]),
  reason: z.string().min(1),
  classification: FactClassificationEnum.optional(),
});

export const ResearchQAOutputSchema = z.object({
  // "retry" is produced only by the node itself (infra failure), never by the
  // LLM: it signals the router to retry the QA node rather than the producer.
  status: z.enum(["approved", "minor_revision", "retry"]),
  feedback: z.string().optional(),
  issues: z.array(z.string()).optional(),
  factsToRegenerate: z.number().int().min(0).optional(),
  factVerdicts: z.array(FactVerdictSchema),
});

export type ResearchQAOutput = z.input<typeof ResearchQAOutputSchema>;
export type FactVerdict = z.input<typeof FactVerdictSchema>;
