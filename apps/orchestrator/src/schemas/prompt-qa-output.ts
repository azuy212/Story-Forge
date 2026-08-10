import { z } from "zod";

const SceneResultSchema = z.object({
  sceneId: z
    .number()
    .int("sceneId must be whole number")
    .positive("sceneId must be positive"),
  verdict: z.enum(["pass", "revise"]),
  feedback: z.string().optional(),
});

export const PromptQAOutputSchema = z.object({
  // "retry" is produced only by the node itself (infra failure), never by the
  // LLM: it signals the router to retry the QA node rather than the producer.
  status: z.enum([
    "approved",
    "minor_revision",
    "major_revision",
    "fatal",
    "retry",
  ]),
  globalFeedback: z.string().optional(),
  issues: z.array(z.string()).optional(),
  sceneResults: z
    .array(SceneResultSchema)
    .min(1, "must have at least one scene result"),
});

export type PromptQAOutput = z.input<typeof PromptQAOutputSchema>;
export type SceneResult = z.input<typeof SceneResultSchema>;
