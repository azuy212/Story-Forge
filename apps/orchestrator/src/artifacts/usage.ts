import type { RunnableConfig } from "@langchain/core/runnables";
import { getArtifactStore, getRunId } from "./context.js";
import { hashObject } from "./hash.js";
import { logger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";
import {
  aggregateUsage,
  type LLMAggregate,
  type LLMUsage,
  type LLMMessageRecord,
} from "../models/usage.js";

/**
 * Per-request context captured alongside usage so records are attributable
 * to a node/attempt and deduplicatable across resumes. `invocationId` is
 * minted before the model call (see `newInvocationId`) and is the idempotency
 * key — dedup never depends on the provider returning an id.
 */
export interface LlmUsageContext {
  runId?: string;
  node: string;
  attempt: number;
  invocationId: string;
}

export type LlmUsageRecord = LLMUsage & Required<LlmUsageContext>;

/**
 * Sanitize the caller-provided chat messages down to the
 * `LLMMessageRecord` shape persisted on the usage artifact. Text content is
 * passed through verbatim; multimodal content parts (image_url blocks) are
 * collapsed to their URL so the artifact stays text-only. Anything we don't
 * recognize is JSON-stringified. Undefined entries are skipped.
 */
function sanitizeInput(messages: unknown): LLMMessageRecord[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const out: LLMMessageRecord[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    if (
      role !== "system" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      continue;
    }
    const raw = (m as { content?: unknown }).content;
    let content: string;
    if (typeof raw === "string") {
      content = raw;
    } else if (Array.isArray(raw)) {
      content = raw
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const p = part as Record<string, unknown>;
          if (typeof p.type === "string" && p.type === "text") {
            return typeof p.text === "string" ? p.text : "";
          }
          if (typeof p.type === "string" && p.type === "image_url") {
            const url = (p.image_url as { url?: unknown } | undefined)?.url;
            return typeof url === "string" ? url : "";
          }
          return "";
        })
        .filter((s) => s.length > 0)
        .join("\n");
    } else {
      content = JSON.stringify(raw ?? null);
    }
    out.push({ role, content });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Best-effort persist of one normalized usage record into the artifact store
 * (type `llmUsage`). Never throws — accounting must not fail generation.
 * No-op when no store/runId (usage tracking rides the artifact store, the
 * same persistence the cache uses), when `usage` is undefined (a request that
 * failed before returning a response has nothing to record), or when the
 * invocation was already recorded (resume idempotency).
 *
 * `debugInput` (the chat messages sent on the wire) and `debugOutput` (the
 * raw model output) are persisted alongside the record when provided so a
 * debug session can reproduce the exact exchange without re-rendering the
 * prompt template or replaying the model call. Both are optional and
 * sanitized through `sanitizeInput` before being stored.
 */
export async function persistLlmUsage(
  config: RunnableConfig | undefined,
  ctx: LlmUsageContext,
  usage: LLMUsage | undefined,
  debugInput?: unknown,
  debugOutput?: string,
): Promise<void> {
  if (!usage) return;
  try {
    const store = getArtifactStore(config);
    if (!store) return;
    const runId = getRunId(config) ?? ctx.runId;
    if (!runId) return;

    const inputHash = hashObject({
      provider: usage.provider,
      invocationId: ctx.invocationId,
    });
    const existing = await store.findCompleteByInputHash<LlmUsageRecord>(
      runId,
      "llmUsage",
      inputHash,
    );
    if (existing) return;

    const sanitizedInput = sanitizeInput(debugInput);

    const record: LlmUsageRecord = {
      ...usage,
      runId,
      node: ctx.node,
      attempt: ctx.attempt,
      invocationId: ctx.invocationId,
      ...(sanitizedInput ? { input: sanitizedInput } : {}),
      ...(typeof debugOutput === "string" && debugOutput.length > 0
        ? { output: debugOutput }
        : {}),
    };

    await store.save(
      runId,
      "llmUsage",
      record,
      {
        inputHash,
        runId,
        node: ctx.node,
        model: usage.model,
        requestId: usage.requestId,
        attempt: ctx.attempt,
        invocationId: ctx.invocationId,
        costUsd: usage.costUsd,
      },
      "complete",
    );
  } catch (err) {
    logger.warn(`Failed to persist LLM usage for ${ctx.node}`, {
      error: getErrorMessage(err),
    });
  }
}

/**
 * Read every persisted usage record for the run and return the aggregate.
 * Undefined when the store/runId is unavailable or no records exist.
 * Never throws.
 */
export async function aggregateForRun(
  config: RunnableConfig | undefined,
): Promise<LLMAggregate | undefined> {
  try {
    const store = getArtifactStore(config);
    const runId = getRunId(config);
    if (!store || !runId) return undefined;
    const records = await store.listAll<LlmUsageRecord>(runId, "llmUsage");
    if (records.length === 0) return undefined;
    return aggregateUsage(records.map((r) => r.data));
  } catch (err) {
    logger.warn("Failed to aggregate LLM usage", {
      error: getErrorMessage(err),
    });
    return undefined;
  }
}
