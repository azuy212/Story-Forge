import type { NodeTelemetry } from "../schemas/diagnostics.js";
import type { ClassificationResult } from "./types.js";

export type ClassificationTelemetryContext = {
  promptVersion?: string;
  agentVersion?: string;
  retries?: number;
};

/**
 * Project a classifier result into the existing NodeTelemetry shape so
 * diagnostics.telemetry[agent] and downstream consumers stay unchanged when a
 * QA gate runs on a classifier instead of a generative LLM.
 */
export function classificationTelemetry(
  result: ClassificationResult,
  context: ClassificationTelemetryContext = {},
): NodeTelemetry {
  return {
    model: `${result.provider}/${result.model}`,
    durationMs: result.durationMs,
    promptTokens: result.usage.inputTokens,
    completionTokens: result.usage.outputTokens,
    totalTokens: result.usage.inputTokens + result.usage.outputTokens,
    retries: context.retries ?? 0,
    promptVersion: context.promptVersion,
    agentVersion: context.agentVersion ?? "1.0.0",
  };
}
