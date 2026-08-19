import type { RunnableConfig } from "@langchain/core/runnables";
import type { ArtifactType } from "./store.js";
import {
  getArtifactStore,
  getRunId,
  completeArtifact,
  recordExecutionRefs,
} from "./context.js";
import { hashObject, hashPrompt } from "./hash.js";
import { loadPrompt as defaultLoadPrompt } from "../utils/load-prompt.js";

export interface CacheOptions<T> {
  type: ArtifactType;
  agent: string;
  promptPath: string;
  variables: Record<string, unknown>;
  temperature?: number;
  responseFormat?: { type: "json_object" } | { type: "text" };
  model?: string;
  agentVersion?: string;
  loadPrompt?: typeof defaultLoadPrompt;
  deferComplete?: boolean;
  validate?: (artifact: T) => boolean;
}

export interface ComputeResult<T> {
  data: T | null;
  error?: string;
  telemetry: {
    model: string;
    durationMs: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    retries: number;
    promptVersion: string;
    agentVersion: string;
    fromCache: boolean;
    artifactRef?: {
      artifactId: string;
      type: string;
      version: number;
      runId: string;
    };
  };
}

export async function runWithArtifactCache<T>(
  options: CacheOptions<T>,
  compute: () => Promise<ComputeResult<T>>,
  config?: RunnableConfig,
): Promise<ComputeResult<T>> {
  const store = getArtifactStore(config);
  const runId = getRunId(config);

  if (!store || !runId) {
    const result = await compute();
    return { ...result, telemetry: { ...result.telemetry, fromCache: false } };
  }

  const loadPrompt = options.loadPrompt ?? defaultLoadPrompt;
  const promptContent = await loadPrompt(options.promptPath);
  const promptHash = hashPrompt(promptContent);

  const key = {
    agent: options.agent,
    promptPath: options.promptPath,
    promptHash,
    variables: options.variables,
    temperature: options.temperature,
    responseFormat: options.responseFormat,
    model: options.model,
    agentVersion: options.agentVersion,
  };
  const inputHash = hashObject(key);

  const matched = await store.findCompleteByInputHash<T>(
    runId,
    options.type,
    inputHash,
  );
  const latest =
    matched?.record ?? (await store.latest<T>(runId, options.type));

  if (
    latest &&
    latest.meta.inputHash === inputHash &&
    latest.status === "complete"
  ) {
    const valid = options.validate ? options.validate(latest.data) : true;
    if (valid) {
      const artifactRef = {
        artifactId: latest.artifactId,
        type: latest.type,
        version: latest.version,
        runId,
      };
      return {
        data: latest.data,
        telemetry: {
          model: latest.meta.model ?? "cached",
          durationMs: 0,
          promptTokens: latest.meta.promptTokens,
          completionTokens: latest.meta.completionTokens,
          totalTokens: latest.meta.totalTokens,
          retries: latest.meta.retries ?? 0,
          promptVersion: latest.meta.promptVersion ?? "",
          agentVersion: latest.meta.agentVersion ?? "",
          fromCache: true,
          artifactRef,
        },
      };
    }
  }

  const result = await compute();

  if (!result.data) {
    return { ...result, telemetry: { ...result.telemetry, fromCache: false } };
  }

  const meta: Record<string, unknown> = {
    inputHash,
    promptVersion: options.promptPath.replace(/\.md$/, ""),
    promptHash,
    promptPath: options.promptPath,
    model: result.telemetry.model,
    temperature: options.temperature,
    producerVersion: `${options.agent}@${options.agentVersion ?? "1"}`,
    agentVersion: result.telemetry.agentVersion,
    runId,
    node: options.agent,
    durationMs: result.telemetry.durationMs,
    promptTokens: result.telemetry.promptTokens,
    completionTokens: result.telemetry.completionTokens,
    totalTokens: result.telemetry.totalTokens,
    retries: result.telemetry.retries,
  };

  const status = options.deferComplete ? "pending" : "complete";

  try {
    const ref = await store.save(
      runId,
      options.type,
      result.data,
      meta,
      status,
    );
    await recordExecutionRefs(config ?? {}, [ref]);
    return {
      ...result,
      telemetry: {
        ...result.telemetry,
        fromCache: false,
        artifactRef: {
          artifactId: ref.artifactId,
          type: ref.type,
          version: ref.version,
          runId,
        },
      },
    };
  } catch {
    return { ...result, telemetry: { ...result.telemetry, fromCache: false } };
  }
}

export async function completeArtifactForNode(
  config: RunnableConfig,
  nodeName: string,
  state?: { execution?: { runId?: string } },
): Promise<void> {
  await completeArtifact(
    config,
    nodeName,
    state as Parameters<typeof completeArtifact>[2],
  );
}

export interface NodeCacheResult<T> {
  data: T | null;
  fromCache: boolean;
  error?: string;
  ref?: { artifactId: string; type: string; version: number; runId: string };
}

export interface CacheNodeOptions<T> {
  type: ArtifactType;
  node: string;
  producerVersion?: string;
  key: Record<string, unknown>;
  deferComplete?: boolean;
  validate?: (artifact: T) => boolean;
  lookupAllVersions?: boolean;
}

export async function cacheNodeResult<T>(
  options: CacheNodeOptions<T>,
  compute: () => Promise<{ data: T | null; error?: string }>,
  config?: RunnableConfig,
): Promise<NodeCacheResult<T>> {
  const store = getArtifactStore(config);
  const runId = getRunId(config);

  if (!store || !runId) {
    const result = await compute();
    return { ...result, fromCache: false };
  }

  const key = { node: options.node, ...options.key };
  const inputHash = hashObject(key);

  const cached = options.lookupAllVersions
    ? await store.findCompleteByInputHash<T>(runId, options.type, inputHash)
    : null;
  const latest = cached?.record ?? (await store.latest<T>(runId, options.type));

  if (
    latest &&
    latest.meta.inputHash === inputHash &&
    latest.status === "complete"
  ) {
    const valid = options.validate ? options.validate(latest.data) : true;
    if (valid) {
      return {
        data: latest.data,
        fromCache: true,
        ref: {
          artifactId: cached?.ref.artifactId ?? latest.artifactId,
          type: latest.type,
          version: latest.version,
          runId,
        },
      };
    }
  }

  const result = await compute();

  if (!result.data) {
    return { data: null, fromCache: false, error: result.error };
  }

  const meta: Record<string, unknown> = {
    inputHash,
    runId,
    node: options.node,
    producerVersion: `${options.node}@${options.producerVersion ?? "1"}`,
    model: "provider",
  };

  const status = options.deferComplete ? "pending" : "complete";

  try {
    const ref = await store.save(
      runId,
      options.type,
      result.data,
      meta,
      status,
    );
    await recordExecutionRefs(config ?? {}, [ref]);
    return {
      data: result.data,
      fromCache: false,
      error: result.error,
      ref: {
        artifactId: ref.artifactId,
        type: ref.type,
        version: ref.version,
        runId,
      },
    };
  } catch {
    return { data: result.data, fromCache: false, error: result.error };
  }
}
