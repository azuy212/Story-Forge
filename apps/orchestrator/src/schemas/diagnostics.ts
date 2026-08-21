import { z } from "zod";

export const ScoresSchema = z.object({
  hookScore: z.number().optional(),
  viralScore: z.number().optional(),
  factScore: z.number().optional(),
  promptScore: z.number().optional(),
  overallScore: z.number().optional(),
});

export type Scores = z.input<typeof ScoresSchema>;

export const NodeTelemetrySchema = z.object({
  model: z.string(),
  durationMs: z.number(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  retries: z.number(),
  promptVersion: z.string().optional(),
  agentVersion: z.string().optional(),
});

export type NodeTelemetry = z.input<typeof NodeTelemetrySchema>;

export const LlmModelUsageSchema = z.object({
  requests: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number().optional(),
});

export type LlmModelUsage = z.input<typeof LlmModelUsageSchema>;

export const LlmUsageAggregateSchema = z.object({
  llmPromptTokens: z.number(),
  llmCompletionTokens: z.number(),
  llmTotalTokens: z.number(),
  llmReasoningTokens: z.number(),
  llmCachedTokens: z.number(),
  llmCacheWriteTokens: z.number(),
  llmCostUsd: z.number().optional(),
  llmRequestCount: z.number(),
  llmModels: z.record(z.string(), LlmModelUsageSchema),
});

export type LlmUsageAggregate = z.input<typeof LlmUsageAggregateSchema>;

export const DiagnosticsSchema = z.object({
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  scores: ScoresSchema.optional(),
  telemetry: z.record(z.string(), NodeTelemetrySchema).optional(),
  llmUsage: LlmUsageAggregateSchema.optional(),
});

export type Diagnostics = z.input<typeof DiagnosticsSchema>;
