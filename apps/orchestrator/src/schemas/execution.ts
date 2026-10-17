import { z } from "zod";
import { ArtifactReferenceSchema } from "../artifacts/types.js";

const NodeResultSchema = z.object({
  status: z.enum(["success", "retry", "revise", "fatal"]),
  message: z.string().optional(),
});

export const ExecutionSchema = z.object({
  status: z.enum(["pending", "running", "complete", "failed"]).optional(),
  currentNode: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  version: z.string(),
  retryCount: z.record(z.string(), z.number()).optional().default({}),
  nodeResult: NodeResultSchema.optional(),
  runId: z.string().optional(),
  artifacts: z
    .record(z.string(), ArtifactReferenceSchema)
    .optional()
    .default({}),
  nodeStatus: z
    .record(z.string(), z.enum(["running", "complete", "failed"]))
    .optional()
    .default({}),
  qaFeedback: z.record(z.string(), z.string()).optional().default({}),
  // Per-QA-node hash (sha256) of the artifact the node reviewed. Trending
  // unchanged artifacts across revision rounds lets the router stop early
  // (non-convergence) instead of burning the full revision budget.
  qaArtifactHash: z.record(z.string(), z.string()).optional().default({}),
});

export type Execution = z.input<typeof ExecutionSchema>;
export type NodeResult = z.input<typeof NodeResultSchema>;
