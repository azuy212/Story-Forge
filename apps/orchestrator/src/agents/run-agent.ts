import { z } from "zod";
import {
  createModel as defaultCreateModel,
  type GenerateOptions,
} from "../models/model-factory.js";
import { loadPrompt as defaultLoadPrompt } from "../utils/load-prompt.js";
import { renderPrompt } from "../utils/render-prompt.js";
import { logger } from "../utils/logger.js";
import { LLMError, isPipelineError, getErrorMessage } from "../utils/errors.js";
import { AgentModel } from "../models/agent-model.js";
import type { NodeTelemetry } from "../schemas/diagnostics.js";
import {
  runWithArtifactCache,
  type ComputeResult,
} from "../artifacts/cache.js";
import { getArtifactDefByNode } from "../artifacts/registry.js";
import type { RunnableConfig } from "@langchain/core/runnables";

import { DEFAULT_MAX_RETRIES } from "../utils/constants.js";

const AGENT_VERSION = "1.0.0";
const DEFAULT_OPTIONS: GenerateOptions = {
  temperature: 0.7,
  responseFormat: { type: "json_object" },
};
const EDITORIAL_GUIDELINES_PATH = "shared/editorial-guidelines.md";
const RETRY_BACKOFF_BASE_MS = 1000;
const RETRY_BACKOFF_MAX_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return (
    Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1)) +
    Math.random() * 250
  );
}

type FailureClass =
  | "parse"
  | "schema"
  | "timeout"
  | "transient"
  | "permanent";

/**
 * Classify a failed LLM attempt so the retry can change the request instead
 * of blindly resending it:
 * - parse/schema: the model produced unusable output — retry WITH feedback.
 * - timeout: request timeout — retry with backoff, no feedback needed.
 * - transient: network/API failure — retry with backoff, no feedback needed.
 * - permanent: no point retrying the same request.
 */
export function classifyError(err: unknown, message: string): FailureClass {
  if (
    message.startsWith("Empty response") ||
    message.includes("Invalid JSON")
  ) {
    return "parse";
  }
  if (message.startsWith("Schema validation failed")) {
    return "schema";
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "TimeoutError"
  ) {
    return "timeout";
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    return "permanent";
  }
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
  if (status === 401 || status === 403 || status === 404 || status === 422) {
    return "permanent";
  }
  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return "transient";
  }
  if (message.length > 0) {
    return "transient";
  }
  return "permanent";
}

export type AgentInject = {
  createModel?: typeof defaultCreateModel;
  loadPrompt?: typeof defaultLoadPrompt;
};

export type RunAgentOptions<T> = {
  agent: AgentModel;
  promptPath: string;
  schema: z.ZodSchema<T>;
  variables: Record<string, string>;
  inject?: AgentInject;
  generateOptions?: GenerateOptions;
  maxRetries?: number;
  /** When true, runAgent performs exactly 1 attempt. Use when caller owns retry logic. */
  singleAttempt?: boolean;
  /** Set false to skip editorial guidelines for this agent. */
  useEditorialGuidelines?: boolean;
  /** Optional run config (config.configurable) passed through for artifact persistence. */
  configurable?: Record<string, unknown>;
  /** When true, the artifact is written as pending and the caller must mark it complete. */
  deferComplete?: boolean;
  /** Semantic validation hook for cached artifacts. */
  validateArtifact?: (artifact: T) => boolean;
};

export type AgentResult<T> = {
  data: T | null;
  telemetry: NodeTelemetry & {
    fromCache?: boolean;
    artifactRef?: {
      artifactId: string;
      type: string;
      version: number;
      runId: string;
    };
  };
  error?: string;
};

function buildTelemetry(
  result: ComputeResult<unknown>,
  promptVersion: string,
): AgentResult<never>["telemetry"] {
  return {
    model: result.telemetry.model,
    durationMs: result.telemetry.durationMs,
    promptTokens: result.telemetry.promptTokens,
    completionTokens: result.telemetry.completionTokens,
    totalTokens: result.telemetry.totalTokens,
    retries: result.telemetry.retries,
    promptVersion,
    agentVersion: result.telemetry.agentVersion,
    fromCache: result.telemetry.fromCache,
    artifactRef: result.telemetry.artifactRef,
  };
}

export async function runAgent<T>({
  agent,
  promptPath,
  schema,
  variables,
  inject = {},
  generateOptions,
  maxRetries = DEFAULT_MAX_RETRIES,
  singleAttempt = false,
  useEditorialGuidelines = true,
  configurable = {},
  deferComplete = false,
  validateArtifact,
}: RunAgentOptions<T>): Promise<AgentResult<T>> {
  const def = getArtifactDefByNode(agent);

  async function compute(): Promise<ComputeResult<T>> {
    const startedAt = Date.now();
    const createModel = inject.createModel ?? defaultCreateModel;
    const loadPrompt = inject.loadPrompt ?? defaultLoadPrompt;
    const attempts = singleAttempt ? 1 : maxRetries;

    logger.info(`${agent} start`, variables);

    const model = createModel(agent);
    const opts: GenerateOptions = { ...DEFAULT_OPTIONS, ...generateOptions };

    const promptContent = await loadPrompt(promptPath);
    const parts = promptContent.split(/\n---\n/);
    const systemTemplate = (parts[0] ?? "").trim();
    const userTemplate = parts[1]?.trim();

    let systemPrompt = renderPrompt(systemTemplate, variables);

    if (useEditorialGuidelines) {
      const guidelines = await loadPrompt(EDITORIAL_GUIDELINES_PATH);
      systemPrompt = `${systemPrompt}\n\n${guidelines}`;
    }

    const userMessage = userTemplate
      ? renderPrompt(userTemplate, variables)
      : undefined;

    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: systemPrompt },
    ];
    if (userMessage) {
      messages.push({ role: "user", content: userMessage });
    }

    let lastError: string | null = null;
    let retryFeedback: string | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        logger.warn(`${agent} retry`, { attempt });
      }

      // Retries after parse/schema failures carry the previous rejection back
      // to the model so the request is not byte-identical.
      const attemptMessages: { role: "system" | "user"; content: string }[] =
        retryFeedback
          ? [...messages, { role: "user", content: retryFeedback }]
          : messages;

      try {
        const response = await model.generate(attemptMessages, opts);

        const rawContent = response?.choices?.[0]?.message?.content;
        if (!rawContent) {
          throw new LLMError("Empty response from model: missing choices or content");
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawContent);
        } catch {
          throw new LLMError("Invalid JSON in model response");
        }

        const result = schema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues
            .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
            .join("; ");
          throw new LLMError(`Schema validation failed: ${issues}`);
        }

        const durationMs = Date.now() - startedAt;

        logger.info(`${agent} success`, {
          durationMs,
          model: model.model,
          retries: attempt - 1,
        });

        const promptVersion = promptPath.replace(/\.md$/, "");
        return {
          data: result.data,
          telemetry: {
            model: model.model,
            durationMs,
            promptTokens: response.usage?.prompt_tokens ?? undefined,
            completionTokens: response.usage?.completion_tokens ?? undefined,
            totalTokens: response.usage?.total_tokens ?? undefined,
            retries: attempt - 1,
            promptVersion,
            agentVersion: AGENT_VERSION,
            fromCache: false,
          },
        };
      } catch (err) {
        if (isPipelineError(err)) {
          lastError = err.message;
        } else {
          lastError = getErrorMessage(err);
        }

        const failureClass = classifyError(err, lastError);

        if (failureClass === "parse" || failureClass === "schema") {
          retryFeedback =
            `Your previous response was rejected:\n${lastError}\n` +
            `Return ONLY corrected valid JSON matching the required schema. ` +
            `No markdown, no commentary, no backticks.`;
        }

        if (
          (failureClass === "transient" || failureClass === "timeout") &&
          attempt < attempts
        ) {
          const delay = backoffMs(attempt);
          logger.warn(`${agent} transient failure, backing off`, {
            attempt,
            delayMs: Math.round(delay),
            error: lastError,
          });
          await sleep(delay);
        }

        if (failureClass === "permanent") {
          logger.error(`${agent} permanent failure, not retrying`, {
            attempt,
            error: lastError,
          });
          break;
        }

        logger.error(`${agent} attempt failed`, {
          attempt,
          error: lastError,
          err,
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.error(`${agent} failed after max retries`, {
      durationMs,
      retries: attempts,
      lastError,
    });

    const promptVersion = promptPath.replace(/\.md$/, "");
    return {
      data: null as T | null,
      telemetry: {
        model: model.model,
        durationMs,
        retries: attempts,
        promptVersion,
        agentVersion: AGENT_VERSION,
        fromCache: false,
      },
      error: lastError ?? "Unknown LLM error",
    };
  }

  const runConfig: RunnableConfig = { configurable };

  const cacheOptions = def
    ? {
        type: def.type,
        agent,
        promptPath,
        variables,
        temperature: generateOptions?.temperature,
        responseFormat: generateOptions?.responseFormat,
        model: configurable.modelForAgent
          ? (configurable.modelForAgent as (agent: string) => string)(agent)
          : undefined,
        agentVersion: AGENT_VERSION,
        loadPrompt: inject.loadPrompt ?? defaultLoadPrompt,
        deferComplete,
        validate: validateArtifact,
      }
    : null;

  const promptVersion = promptPath.replace(/\.md$/, "");

  if (cacheOptions) {
    try {
      const result = await runWithArtifactCache<T>(
        cacheOptions,
        compute,
        runConfig,
      );
      if (result.error || !result.data) {
        return {
          data: null,
          telemetry: buildTelemetry(
            result as ComputeResult<unknown>,
            promptVersion,
          ),
          error: result.error ?? "Unknown LLM error",
        };
      }
      return {
        data: result.data,
        telemetry: buildTelemetry(
          result as ComputeResult<unknown>,
          promptVersion,
        ),
        error: undefined,
      };
    } catch (err) {
      const message = isPipelineError(err) ? err.message : getErrorMessage(err);
      return {
        data: null,
        telemetry: {
          model: "unknown",
          durationMs: 0,
          retries: maxRetries,
          promptVersion,
          agentVersion: AGENT_VERSION,
          fromCache: false,
        },
        error: message,
      };
    }
  }

  try {
    const result = await compute();
    if (result.error || !result.data) {
      return {
        data: null,
        telemetry: buildTelemetry(
          result as ComputeResult<unknown>,
          promptVersion,
        ),
        error: result.error ?? "Unknown LLM error",
      };
    }
    return {
      data: result.data,
      telemetry: buildTelemetry(
        result as ComputeResult<unknown>,
        promptVersion,
      ),
      error: undefined,
    };
  } catch (err) {
    const message = isPipelineError(err) ? err.message : getErrorMessage(err);
    return {
      data: null,
      telemetry: {
        model: "unknown",
        durationMs: 0,
        retries: maxRetries,
        promptVersion,
        agentVersion: AGENT_VERSION,
        fromCache: false,
      },
      error: message,
    };
  }
}
