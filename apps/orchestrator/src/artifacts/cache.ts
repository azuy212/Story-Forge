import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ArtifactType,
  ArtifactReference,
  ArtifactStore,
} from "./store.js";
import {
  getArtifactStore,
  getRunId,
  completeArtifact,
  recordExecutionRefs,
} from "./context.js";
import { hashObject, hashPrompt } from "./hash.js";
import {
  ARTIFACT_TYPES,
  getArtifactDef,
  validateArtifact,
} from "./registry.js";
import { loadPrompt as defaultLoadPrompt } from "../utils/load-prompt.js";
import { logger } from "../utils/logger.js";

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

interface ManualCandidate<T = unknown> {
  source: string;
  fileName: string;
  data: T;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readManualArtifactsMap(
  config?: RunnableConfig,
): Record<string, unknown> | null {
  const cfg = config?.configurable as Record<string, unknown> | undefined;
  const raw = cfg?.manualArtifacts;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      'manualArtifacts must be an object mapping artifact type -> file path (or array of paths), e.g. { "promptQA": "/abs/promptQA.json" }',
    );
  }
  return raw as Record<string, unknown>;
}

function assertInjectableTypeKeys(map: Record<string, unknown>): void {
  for (const key of Object.keys(map)) {
    if (!getArtifactDef(key as ArtifactType)) {
      const valid = ARTIFACT_TYPES.map((d) => d.type).join(", ");
      throw new Error(
        `manualArtifacts key "${key}" is not an injectable artifact type (valid: ${valid})`,
      );
    }
  }
}

async function readJsonCandidate(path: string): Promise<ManualCandidate> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Manual artifact override not readable at "${path}": ${errorMessage(err)}`,
      { cause: err },
    );
  }
  try {
    return { source: path, fileName: basename(path), data: JSON.parse(raw) };
  } catch (err) {
    throw new Error(
      `Manual artifact override is not valid JSON at "${path}": ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

async function expandManualPaths(paths: string[]): Promise<ManualCandidate[]> {
  const candidates: ManualCandidate[] = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch (err) {
      throw new Error(
        `Manual artifact override path not found: "${path}": ${errorMessage(err)}`,
        { cause: err },
      );
    }
    if (!info.isDirectory()) {
      candidates.push(await readJsonCandidate(path));
      continue;
    }
    let files: string[];
    try {
      files = await readdir(path);
    } catch (err) {
      throw new Error(
        `Manual artifact override directory not readable: "${path}": ${errorMessage(err)}`,
        { cause: err },
      );
    }
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
    for (const file of jsonFiles) {
      candidates.push(await readJsonCandidate(join(path, file)));
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `Manual artifact override resolved no JSON files from: ${paths.join(", ")}`,
    );
  }
  return candidates;
}

/**
 * Picks the candidate that applies to this cache call:
 * - keyed calls (`key.sceneId`, `key.kind`) match `scene-<id>.json` /
 *   `<kind>.json` names so a directory can serve per-scene artifacts;
 *   a miss returns null (this call falls through to the normal hash path —
 *   e.g. combined-only injection must not break cached scene lookups).
 * - unkeyed LLM-agent calls require a single file (ambiguous otherwise).
 */
function selectManualCandidate(
  candidates: ManualCandidate[],
  type: ArtifactType,
  key?: Record<string, unknown>,
): ManualCandidate | null {
  const sceneId =
    typeof key?.sceneId === "number" ? (key.sceneId as number) : undefined;
  if (sceneId !== undefined) {
    const wanted = `scene-${sceneId}.json`;
    return candidates.find((c) => c.fileName === wanted) ?? null;
  }
  const kind = typeof key?.kind === "string" ? (key.kind as string) : undefined;
  if (kind !== undefined) {
    const wanted = `${kind}.json`;
    const hit = candidates.find((c) => c.fileName === wanted);
    if (hit) return hit;
    const single = candidates.length === 1 ? candidates[0] : null;
    // Never hand a scene file to a non-scene key (and vice versa): a lone
    // `scene-N.json` is scene data, not a combined artifact.
    if (single && !/^scene-\d+\.json$/.test(single.fileName)) return single;
    return null;
  }
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    `Manual artifact override for "${type}" is ambiguous (${candidates.length} files: ${candidates
      .map((c) => c.fileName)
      .join(", ")}); pass a single file for this type`,
  );
}

/**
 * Manual artifact escape hatch for a stuck run: when
 * `config.configurable.manualArtifacts[type]` points at a JSON file (or
 * directory of `scene-<id>.json` / `<kind>.json` files), the file's payload —
 * the node's zod output — is persisted as a complete artifact and served in
 * place of the LLM/provider call, bypassing the input-hash check entirely.
 *
 * Returns null when no override is configured for this type (or the override
 * does not match this cache key) so the normal hash path runs. Throws when an
 * override is configured but unusable (missing file, bad JSON, schema/node
 * validation failure, unknown type key) — a broken override must surface
 * loudly rather than silently re-running the stuck node.
 */
async function resolveManualOverride<T>(options: {
  store: ArtifactStore;
  runId: string;
  config?: RunnableConfig;
  type: ArtifactType;
  nodeName: string;
  key?: Record<string, unknown>;
  nodeValidate?: (data: T) => boolean;
}): Promise<{ data: T; ref: ArtifactReference } | null> {
  const map = readManualArtifactsMap(options.config);
  if (!map) return null;
  assertInjectableTypeKeys(map);

  const entry = map[options.type];
  if (entry === undefined || entry === null) return null;

  const paths = (Array.isArray(entry) ? entry : [entry]).map((p) => {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error(
        `manualArtifacts["${options.type}"] must be a file path or array of file paths`,
      );
    }
    return p;
  });

  const candidates = await expandManualPaths(paths);
  const selected = selectManualCandidate(candidates, options.type, options.key);
  if (!selected) {
    logger.debug(
      "Manual artifact override did not match this cache key; using normal cache path",
      {
        type: options.type,
        available: candidates.map((c) => c.fileName),
      },
    );
    return null;
  }

  const configurable = options.config?.configurable as
    Record<string, unknown> | undefined;
  const profileRaw = configurable?.manualArtifactProfile;
  const profile =
    profileRaw === "short" || profileRaw === "long" ? profileRaw : undefined;

  let validated: T;
  try {
    validated = validateArtifact(options.type, selected.data as T, profile);
  } catch (err) {
    throw new Error(
      `Manual artifact override invalid for type "${options.type}" (${selected.source}): ${errorMessage(err)}`,
      { cause: err },
    );
  }
  if (options.nodeValidate && !options.nodeValidate(validated)) {
    throw new Error(
      `Manual artifact override rejected by node validation for type "${options.type}" (${selected.source})`,
    );
  }

  const ref = await options.store.save(
    options.runId,
    options.type,
    validated,
    {
      // Empty hash: the override short-circuits the hash gate, and a later
      // plain resume (without the flag) must NOT accidentally hit this
      // record — it recomputes instead.
      inputHash: "",
      runId: options.runId,
      node: options.nodeName,
      sourceOverride: true,
      ...(profile ? { manualArtifactProfile: profile } : {}),
    },
    "complete",
  );
  await recordExecutionRefs(options.config ?? {}, [ref]);
  logger.debug("Manual artifact override applied", {
    type: options.type,
    source: selected.source,
    version: ref.version,
    runId: options.runId,
  });
  return { data: validated, ref };
}

export interface ComputeResult<T> {
  data: T | null;
  error?: string;
  /**
   * Passed through untouched from `compute`. Carries the last parsed-but-
   * schema-rejected payload so callers can attempt a lenient recovery; the
   * cache never persists it (a rejected payload is not a valid artifact).
   */
  rejected?: unknown;
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

  const override = await resolveManualOverride<T>({
    store,
    runId,
    config,
    type: options.type,
    nodeName: options.agent,
    nodeValidate: options.validate,
  });
  if (override) {
    return {
      data: override.data,
      telemetry: {
        model: "manual",
        durationMs: 0,
        retries: 0,
        promptVersion: options.promptPath.replace(/\.md$/, ""),
        agentVersion: options.agentVersion ?? "",
        fromCache: true,
        artifactRef: override.ref,
      },
    };
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

  try {
    const override = await resolveManualOverride<T>({
      store,
      runId,
      config,
      type: options.type,
      nodeName: options.node,
      key: options.key,
      nodeValidate: options.validate,
    });
    if (override) {
      return {
        data: override.data,
        fromCache: true,
        ref: override.ref,
      };
    }
  } catch (err) {
    return {
      data: null,
      fromCache: false,
      error:
        err instanceof Error
          ? err.message
          : `Manual artifact override failed: ${String(err)}`,
    };
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
