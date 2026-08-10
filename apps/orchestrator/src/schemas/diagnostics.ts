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

export const DiagnosticsSchema = z.object({
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  scores: ScoresSchema.optional(),
  telemetry: z.record(z.string(), NodeTelemetrySchema).optional(),
});

export type Diagnostics = z.input<typeof DiagnosticsSchema>;
