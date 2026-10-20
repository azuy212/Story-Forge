import { hashObject } from "../artifacts/hash.js";
import { readJsonFile, writeJsonFile } from "./atomic.js";
import { STORY_STAGES } from "./types.js";
import type {
  ResolvedStoryConfig,
  StageRecord,
  StoryJobInput,
  StoryManifest,
  StoryStage,
} from "./types.js";

export const MANIFEST_VERSION = 1 as const;

/** Fingerprint helper: stable hash of a stage's inputs and relevant config. */
export function stageFingerprint(value: unknown): string {
  return hashObject(value);
}

function toInput(config: ResolvedStoryConfig): StoryJobInput {
  return {
    topic: config.topic,
    targetDurationSec: config.targetDurationSec,
    language: config.language,
    tone: config.tone,
    style: config.style,
    jobId: config.jobId,
    outputDir: config.outputDir,
  };
}

export function createManifest(
  config: ResolvedStoryConfig,
  jobId: string,
): StoryManifest {
  const now = new Date().toISOString();
  const input = { ...toInput(config), jobId };
  return {
    version: MANIFEST_VERSION,
    jobId,
    createdAt: now,
    updatedAt: now,
    input,
    config: { ...config, jobId },
    stages: {},
    groundingSource: "model-knowledge",
    unverified: true,
    scenes: [],
    warnings: [],
    errors: [],
  };
}

/**
 * Load an existing manifest for the job, or create a fresh one. An existing
 * manifest keeps its per-scene artifacts and stage records so a resume only
 * reruns work whose fingerprint changed (brief section 8). A manifest whose
 * `version` is unknown is ignored rather than silently reinterpreted.
 */
export async function loadOrCreateManifest(
  manifestPath: string,
  config: ResolvedStoryConfig,
  jobId: string,
): Promise<{ manifest: StoryManifest; resumed: boolean }> {
  const existing = await readJsonFile<StoryManifest>(manifestPath);
  if (existing && existing.version === MANIFEST_VERSION) {
    const manifest: StoryManifest = {
      ...existing,
      jobId,
      input: { ...toInput(config), jobId },
      config: { ...config, jobId },
      stages: existing.stages ?? {},
      scenes: existing.scenes ?? [],
      warnings: existing.warnings ?? [],
      errors: existing.errors ?? [],
    };
    // A stage left `running` by a crash is incomplete on resume.
    for (const stage of STORY_STAGES) {
      const record = manifest.stages[stage];
      if (record?.status === "running") {
        record.status = "pending";
      }
    }
    return { manifest, resumed: true };
  }
  return { manifest: createManifest(config, jobId), resumed: false };
}

export async function saveManifest(
  manifestPath: string,
  manifest: StoryManifest,
): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await writeJsonFile(manifestPath, manifest);
}

export function setStage(
  manifest: StoryManifest,
  stage: StoryStage,
  patch: Partial<StageRecord>,
): StageRecord {
  const record: StageRecord = { status: "pending", ...manifest.stages[stage] };
  Object.assign(record, patch);
  manifest.stages[stage] = record;
  return record;
}

/** Merge stage metrics without disturbing status/fingerprint/timing fields. */
export function updateStageMetrics(
  manifest: StoryManifest,
  stage: StoryStage,
  patch: Record<string, unknown>,
): void {
  const record: StageRecord = manifest.stages[stage] ?? { status: "running" };
  record.metrics = { ...record.metrics, ...patch };
  manifest.stages[stage] = record;
}

export function addWarning(manifest: StoryManifest, message: string): void {
  if (!manifest.warnings.includes(message)) manifest.warnings.push(message);
}

export function stageRecord(
  manifest: StoryManifest,
  stage: StoryStage,
): StageRecord | undefined {
  return manifest.stages[stage];
}

export function isStageDone(
  manifest: StoryManifest,
  stage: StoryStage,
  fingerprint?: string,
): boolean {
  const record = manifest.stages[stage];
  if (!record || record.status !== "done") return false;
  if (fingerprint === undefined) return true;
  return record.fingerprint === fingerprint;
}
