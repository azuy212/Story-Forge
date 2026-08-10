import { z } from "zod";

export const ScriptQAOutputSchema = z.object({
  // "retry" is produced only by the node itself (infra failure), never by the
  // LLM: it signals the router to retry the QA node rather than the producer.
  status: z.enum(["approved", "minor_revision", "fatal", "retry"]),
  feedback: z.string().optional(),
  issues: z.array(z.string()).optional(),
});

export type ScriptQAOutput = z.input<typeof ScriptQAOutputSchema>;
