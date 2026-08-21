import type { RunnableConfig } from "@langchain/core/runnables";
import { getArtifactStore, getRunId } from "./context.js";
import { hashObject } from "./hash.js";
import { logger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";
import {
  aggregateUsage,
  type LLMAggregate,
  type LLMUsage,
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
 * Best-effort persist of one normalized usage record into the artifact store
 * (type `llmUsage`). Never throws — accounting must not fail generation.
 * No-op when no store/runId (usage tracking rides the artifact store, the
 * same persistence the cache uses), when `usage` is undefined (a request that
 * failed before returning a response has nothing to record), or when the
 * invocation was already recorded (resume idempotency).
 */
export async function persistLlmUsage(
  config: RunnableConfig | undefined,
  ctx: LlmUsageContext,
  usage: LLMUsage | undefined,
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

    const record: LlmUsageRecord = {
      ...usage,
      runId,
      node: ctx.node,
      attempt: ctx.attempt,
      invocationId: ctx.invocationId,
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
