import type { RunnableConfig } from "@langchain/core/runnables";
import type { ArtifactStore, ArtifactReference } from "./store.js";
import type { ProjectState } from "../types/index.js";
import { randomUUID } from "node:crypto";
import { FilesystemArtifactStore } from "./fs/fs-artifact-store.js";
import { getArtifactDefByNode } from "./registry.js";
import { config as appConfig } from "../utils/config.js";
import { slugify } from "../utils/slugify.js";

let _artifactStore: ArtifactStore | null = null;

export function getArtifactStore(config?: RunnableConfig): ArtifactStore | null {
  const cfg = config?.configurable as Record<string, unknown> | undefined;
  if (cfg?.artifactStore) return cfg.artifactStore as ArtifactStore;
  if (cfg?.artifactStore === null) return null;
  if (_artifactStore) return _artifactStore;
  if (cfg?.artifactStoreEnabled === false) return null;
  if (cfg?.artifactStoreEnabled === true || appConfig.artifactStoreEnabled()) {
    _artifactStore = new FilesystemArtifactStore();
    return _artifactStore;
  }
  return null;
}

export function setArtifactStore(store: ArtifactStore): void {
  _artifactStore = store;
}

export function resetArtifactStore(): void {
  _artifactStore = null;
}

export function getRunId(config?: RunnableConfig, state?: ProjectState): string | null {
  const cfg = config?.configurable as Record<string, unknown> | undefined;
  if (cfg?.runId && typeof cfg.runId === "string") return cfg.runId;
  if (cfg?.thread_id && typeof cfg.thread_id === "string") return cfg.thread_id;
  if (state?.execution?.runId) return state.execution.runId;
  return null;
}

export function ensureRunId(config?: RunnableConfig, state?: ProjectState): string {
  return getRunId(config, state) ?? randomUUID();
}

export function getArtifactNamespace(config?: RunnableConfig, state?: ProjectState): string {
  return getRunId(config, state) ?? slugify(state?.project?.topic ?? "untitled");
}

export async function completeArtifact(
  config: RunnableConfig,
  nodeName: string,
  state?: ProjectState
): Promise<void> {
  const store = getArtifactStore(config);
  if (!store) return;
  const runId = getRunId(config, state);
  if (!runId) return;
  const def = getArtifactDefByNode(nodeName);
  if (!def) return;
  const manifest = await store.getManifest(runId);
  const typeManifest = manifest?.[def.type];
  if (!typeManifest?.latest) return;
  const version = Number(typeManifest.latest.replace("v", ""));
  if (Number.isInteger(version) && version > 0) {
    await store.markStatus(runId, def.type, version, "complete");
  }
}

export async function invalidateArtifact(
  config: RunnableConfig,
  nodeName: string,
  state?: ProjectState
): Promise<void> {
  const store = getArtifactStore(config);
  if (!store) return;
  const runId = getRunId(config, state);
  if (!runId) return;
  const def = getArtifactDefByNode(nodeName);
  if (!def) return;
  const manifest = await store.getManifest(runId);
  const typeManifest = manifest?.[def.type];
  if (!typeManifest?.latest) return;
  const version = Number(typeManifest.latest.replace("v", ""));
  if (Number.isInteger(version) && version > 0) {
    await store.markStatus(runId, def.type, version, "invalid");
  }
}

export function isArtifactStoreEnabled(config?: RunnableConfig): boolean {
  return getArtifactStore(config) !== null;
}

export async function recordExecutionRefs(
  config: RunnableConfig,
  refs: ArtifactReference[],
  state?: ProjectState
): Promise<void> {
  const store = getArtifactStore(config);
  if (!store) return;
  const runId = getRunId(config, state);
  if (!runId) return;
  for (const ref of refs) {
    await store.recordRef(runId, ref);
  }
}