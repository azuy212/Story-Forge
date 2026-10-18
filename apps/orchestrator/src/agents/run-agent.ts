import { z } from "zod";
import {
  createModel as defaultCreateModel,
  type GenerateOptions,
} from "../models/model-factory.js";
import { loadPrompt as defaultLoadPrompt } from "../utils/load-prompt.js";
import { renderPrompt } from "../utils/render-prompt.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import { LLMError, isPipelineError, getErrorMessage } from "../utils/errors.js";
import { AgentModel } from "../models/agent-model.js";
import type { NodeTelemetry } from "../schemas/diagnostics.js";
import {
  runWithArtifactCache,
  type ComputeResult,
} from "../artifacts/cache.js";
import { getArtifactDefByNode } from "../artifacts/registry.js";
import { persistLlmUsage } from "../artifacts/usage.js";
import { newInvocationId } from "../models/usage.js";
import { config as configUtils } from "../utils/config.js";
import {
  LOG_TEXT_LIMIT,
  sanitizeForLog,
  sanitizeUnknownForLog,
} from "../utils/log-redaction.js";
import type { RunnableConfig } from "@langchain/core/runnables";

import { DEFAULT_MAX_RETRIES } from "../utils/constants.js";
import { hashPrompt } from "../artifacts/hash.js";
import {
  appendRunLogEvent,
  getRunLogSinkFromConfig,
  type RunLogSink,
} from "../utils/run-log.js";
import type { ClassifierFactory } from "../classifiers/types.js";

const AGENT_VERSION = "1.0.0";
const DEFAULT_OPTIONS: GenerateOptions = {
  temperature: 0.7,
  responseFormat: { type: "json_object" },
};
const EDITORIAL_GUIDELINES_PATH = "shared/editorial-guidelines.md";
const RETRY_BACKOFF_BASE_MS = 1000;
const RATE_LIMIT_BACKOFF_BASE_MS = 5000;
const RETRY_BACKOFF_MAX_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, baseMs = RETRY_BACKOFF_BASE_MS): number {
  return (
    Math.min(RETRY_BACKOFF_MAX_MS, baseMs * 2 ** (attempt - 1)) +
    Math.random() * 250
  );
}

type FailureClass = "parse" | "schema" | "timeout" | "transient" | "permanent";

/**
 * Classify a failed LLM attempt so the retry can change the request instead
 * of blindly resending it:
 * - parse/schema: the model produced unusable output — retry WITH feedback.
 * - timeout: request timeout — retry with backoff, no feedback needed.
 * - transient: network/API failure — retry with backoff, no feedback needed.
 * - permanent: no point retrying the same request.
 */
/**
 * Build the feedback message sent back to the model when a parse/schema
 * rejection needs a corrected retry. The rejected raw output is attached
 * verbatim so the model can see exactly what it produced. When no raw output
 * is available (e.g. timeout/transient failure) only the rejection reason is
 * returned; stale content is never attached.
 */
export function buildRetryFeedback(
  lastError: string,
  rawContent?: string | null,
): string {
  const rawBlock =
    rawContent != null && rawContent.length > 0
      ? `\n\nPrevious response:\n"""\n${rawContent}\n"""`
      : "";
  return (
    `Your previous response was rejected:\n${lastError}${rawBlock}\n` +
    `Return ONLY corrected valid JSON matching the required schema. ` +
    `No markdown, no commentary, no backticks.`
  );
}

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

function normalizeError(err: unknown, message: string): string {
  if (
    message.startsWith("Empty response") ||
    message.includes("missing choices or content")
  ) {
    return "empty model response";
  }
  if (message.includes("Invalid JSON")) {
    return "invalid JSON response";
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "TimeoutError"
  ) {
    return "request timed out";
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    return "request aborted";
  }
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
  if (status === 429) {
    return "rate limited";
  }
  if (typeof status === "number" && status >= 500) {
    return "provider unavailable";
  }
  return "request failed";
}

export type AgentInject = {
  createModel?: typeof defaultCreateModel;
  loadPrompt?: typeof defaultLoadPrompt;
  createClassifier?: ClassifierFactory;
};

export type RunAgentOptions<TParsed, TResult = TParsed> = {
  agent: AgentModel;
  promptPath: string;
  schema: z.ZodSchema<TParsed>;
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
  validateArtifact?: (artifact: TResult) => boolean;
  /**
   * Version of this agent's deterministic code that transforms the model
   * output on top of the prompt. When set, it participates in the artifact
   * input hash, so cached artifacts never outlive the code that shaped them.
   * Agents without such a transform simply omit it.
   */
  codeVersion?: number | string;
  /**
   * Optional content-level post-process, run after schema validation succeeds
   * but before the response is considered usable.
   *
   * - Success: the returned `data` replaces the schema output everywhere —
   *   it is what the artifact persists (with `metaExtras` merged into the
   *   artifact meta) and what the caller receives. This is how derived
   *   artifacts (e.g. VisualDirector narration built from unit ids) reach the
   *   store and the state in one shape.
   * - Failure (return a message string): treated like a schema rejection —
   *   the message is sent back to the model as retry feedback and the attempt
   *   is counted as failed. Use it when the caller can retry the model with
   *   specific content feedback.
   */
  postProcess?: (
    data: TParsed,
  ) => { data: TResult; metaExtras?: Record<string, unknown> } | string;
};

export type AgentResult<TData> = {
  data: TData | null;
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
  /**
   * Most recent response that parsed as JSON but failed schema validation,
   * returned alongside `error` when every attempt was rejected.
   *
   * A strict schema can reject a payload whose only defects are cosmetic, and
   * discarding the parsed value there leaves the caller with nothing to fall
   * back on. Callers that can repair structurally-sound output may attempt
   * their own lenient parse of this before giving up. Undefined when no attempt
   * ever produced parseable JSON (timeout / transport failures).
   */
  rejected?: unknown;
};

function buildTelemetry<T>(
  result: ComputeResult<T>,
  promptVersion: string,
): AgentResult<T>["telemetry"] {
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

export async function runAgent<TParsed, TResult = TParsed>({
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
  postProcess,
  codeVersion,
}: RunAgentOptions<TParsed, TResult>): Promise<AgentResult<TResult>> {
  const def = getArtifactDefByNode(agent);

  async function compute(): Promise<ComputeResult<TResult>> {
    const startedAt = Date.now();
    const createModel = inject.createModel ?? defaultCreateModel;
    const loadPrompt = inject.loadPrompt ?? defaultLoadPrompt;
    const attempts = singleAttempt ? 1 : maxRetries;
    const runLogSink: RunLogSink | null = getRunLogSinkFromConfig({
      configurable,
    } as Parameters<typeof getRunLogSinkFromConfig>[0]);
    const runId =
      typeof (configurable as Record<string, unknown>).runId === "string"
        ? ((configurable as Record<string, unknown>).runId as string)
        : undefined;
    const promptVersion = promptPath.replace(/\.md$/, "");

    logger.debug(`${agent} variables`, {
      keys: Object.keys(variables),
      totalChars: Object.values(variables).reduce(
        (sum, v) => sum + v.length,
        0,
      ),
    });

    const promptContent = await loadPrompt(promptPath);
    const promptHash = hashPrompt(promptContent);
    const model = createModel(agent, {
      runLogSink,
      promptPath,
      promptVersion,
      promptHash,
      runId,
    });
    const opts: GenerateOptions = { ...DEFAULT_OPTIONS, ...generateOptions };
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
    let lastRejected: unknown;
    let sawRejected = false;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1 && lastError) {
        const reason = normalizeError(new Error(lastError), lastError);
        logger.nodeRetry(nodeLabel(agent), attempt, attempts, reason);
      }

      // Retries after parse/schema failures carry the previous rejection back
      // to the model so the request is not byte-identical.
      const attemptMessages: { role: "system" | "user"; content: string }[] =
        retryFeedback
          ? [...messages, { role: "user", content: retryFeedback }]
          : messages;

      // Reset per attempt so the catch block can attach the rejected output
      // verbatim to the parse/schema retry feedback. Stays undefined (so no
      // stale content is attached) for timeout/transient failures.
      let rawContent: string | undefined;
      let persistDebugOutput: string | undefined;
      const invocationId = newInvocationId();
      if (typeof model.setCallContext === "function") {
        model.setCallContext({ attempt, invocationId });
      }

      // DEBUG: dump the request payload for inspection. Set DEBUG_LLM_PAYLOAD=1
      // to enable (off by default). Even with it on, secrets are redacted and
      // every field is capped so an opt-in dump cannot spill a key or the whole
      // script into the log file.
      if (configUtils.debugLlmPayload()) {
        logger.debug(`${agent} LLM request payload`, {
          model: model.model,
          attempt,
          invocationId,
          generateOptions: sanitizeUnknownForLog(opts),
          messages: sanitizeUnknownForLog(attemptMessages),
        });
      }

      try {
        const llmResult = await model.generate(attemptMessages, opts);

        // Persist usage for EVERY completed request — including attempts that
        // then fail JSON/schema validation, since those consumed tokens.
        // Best-effort: accounting never fails generation.
        await persistLlmUsage(
          { configurable },
          { node: agent, attempt, invocationId },
          llmResult.usage,
          attemptMessages,
          persistDebugOutput ?? llmResult.output,
        );
        if (!llmResult.usage) {
          logger.warn(`${agent} response did not include usage`, {
            attempt,
          });
        }

        rawContent = llmResult.output;
        if (!rawContent) {
          throw new LLMError(
            "Empty response from model: missing choices or content",
          );
        }

        // The persisted copy of the raw output is capped: it exists for
        // diagnosis, not as a second copy of the script.
        persistDebugOutput = sanitizeForLog(rawContent, {
          maxChars: LOG_TEXT_LIMIT,
        });

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
          // Retain the parsed value so a caller that can repair cosmetic schema
          // drift still has a candidate once every attempt has been rejected.
          lastRejected = parsed;
          sawRejected = true;
          throw new LLMError(`Schema validation failed: ${issues}`);
        }

        // Content-level post-process (e.g. VisualDirector unit repair + narration
        // derivation): validated output is transformed before it counts as a
        // usable response. A failure message is treated like a schema rejection
        // and fed back to the model with the specific problem attached.
        let finalData: TResult;
        let metaExtras: Record<string, unknown> | undefined;
        if (postProcess) {
          const outcome = postProcess(result.data);
          if (typeof outcome === "string") {
            lastRejected = parsed;
            sawRejected = true;
            throw new LLMError(`Schema validation failed: ${outcome}`);
          }
          finalData = outcome.data;
          metaExtras = outcome.metaExtras;
        } else {
          // No postProcess: TResult is TParsed by construction — the generic
          // is only widened when postProcess supplies the mapping, so the same
          // value serves both types here.
          finalData = result.data as TParsed & TResult;
        }

        const durationMs = Date.now() - startedAt;

        logger.debug(`${agent} model call complete`, {
          model: model.model,
          totalTokens: llmResult.usage?.totalTokens,
          costUsd: llmResult.usage?.costUsd,
        });

        return {
          data: finalData,
          metaExtras,
          telemetry: {
            model: model.model,
            durationMs,
            promptTokens: llmResult.usage?.promptTokens,
            completionTokens: llmResult.usage?.completionTokens,
            totalTokens: llmResult.usage?.totalTokens,
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
          retryFeedback = buildRetryFeedback(lastError, rawContent);
          appendRunLogEvent(runLogSink, {
            event: "log_message",
            level: "warn",
            message: `${agent} ${failureClass} rejection`,
            meta: {
              attempt,
              errorClass: failureClass,
              error: lastError,
              rawContentLength: rawContent?.length ?? 0,
              rawContentPreview: rawContent
                ? rawContent.slice(0, 2000)
                : undefined,
            },
          });
        }

        if (
          (failureClass === "transient" || failureClass === "timeout") &&
          attempt < attempts
        ) {
          const status =
            typeof err === "object" && err !== null && "status" in err
              ? (err as { status?: unknown }).status
              : undefined;
          const delay = backoffMs(
            attempt,
            status === 429 ? RATE_LIMIT_BACKOFF_BASE_MS : undefined,
          );
          logger.debug(`${agent} transient failure, backing off`, {
            attempt,
            delayMs: Math.round(delay),
            error: lastError,
          });
          await sleep(delay);
        }

        if (failureClass === "permanent") {
          break;
        }

        logger.debug(`${agent} attempt failed`, {
          attempt,
          model: model.model,
          error: lastError,
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    return {
      data: null,
      ...(sawRejected ? { rejected: lastRejected } : {}),
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
  const promptVersion = promptPath.replace(/\.md$/, "");

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
        // Agents with a deterministic output transform (e.g. the
        // VisualDirector's unit pipeline) pass codeVersion so cached
        // storyboards never outlive the code that shaped them.
        codeVersion,
        loadPrompt: inject.loadPrompt ?? defaultLoadPrompt,
        deferComplete,
        validate: validateArtifact,
      }
    : null;

  if (cacheOptions) {
    try {
      const result = await runWithArtifactCache<TResult>(
        cacheOptions,
        compute,
        runConfig,
      );
      if (result.error || !result.data) {
        return {
          data: null,
          telemetry: buildTelemetry(result, promptVersion),
          error: result.error ?? "Unknown LLM error",
          rejected: result.rejected,
        };
      }
      return {
        data: result.data,
        telemetry: buildTelemetry(result, promptVersion),
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
        telemetry: buildTelemetry(result, promptVersion),
        error: result.error ?? "Unknown LLM error",
        rejected: result.rejected,
      };
    }
    return {
      data: result.data,
      telemetry: buildTelemetry(result, promptVersion),
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
