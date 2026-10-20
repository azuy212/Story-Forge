import { logger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";
import { isStageDone, saveManifest, setStage } from "./manifest.js";
import type { JobPaths } from "./paths.js";
import type { StoryManifest, StoryStage } from "./types.js";

export interface StoryRunContext {
  manifest: StoryManifest;
  paths: JobPaths;
  /** Stages forced to rerun regardless of their stored fingerprint. */
  forceStages: Set<StoryStage>;
}

const STAGE_LABELS: Record<StoryStage, string> = {
  S1_input: "Story input",
  S2_story: "Story writing",
  S3_scenes: "Scene planning",
  S4_visual_plan: "Visual plan",
  S5_images: "Scene images",
  S6_audio: "Narration audio",
  S7_align: "Alignment and subtitles",
  S8_render: "Render and validation",
};

export function stageLabel(stage: StoryStage): string {
  return STAGE_LABELS[stage];
}

/**
 * Run a stage under fingerprint-based resume.
 *
 * - `done` + unchanged fingerprint + not forced → skipped entirely.
 * - otherwise the stage record is set `running` and persisted BEFORE the work
 *   starts, so a crash leaves it `running` (treated as incomplete on resume).
 * - success sets `done`; failure sets `failed` with the message and rethrows.
 *
 * Returns the stage's value, or undefined when the stage was skipped.
 */
export async function runStage<T>(
  ctx: StoryRunContext,
  stage: StoryStage,
  fingerprint: string | undefined,
  fn: (ctx: StoryRunContext) => Promise<T>,
): Promise<T | undefined> {
  const label = stageLabel(stage);

  if (
    !ctx.forceStages.has(stage) &&
    isStageDone(ctx.manifest, stage, fingerprint)
  ) {
    logger.info(`Story ${label}: reused (fingerprint unchanged)`);
    return undefined;
  }

  const startedAt = Date.now();
  setStage(ctx.manifest, stage, {
    status: "running",
    fingerprint,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: undefined,
    durationMs: undefined,
    error: undefined,
  });
  await saveManifest(ctx.paths.manifest, ctx.manifest);
  logger.nodeStart(label);

  try {
    const result = await fn(ctx);
    const durationMs = Date.now() - startedAt;
    setStage(ctx.manifest, stage, {
      status: "done",
      fingerprint,
      finishedAt: new Date().toISOString(),
      durationMs,
      error: undefined,
    });
    await saveManifest(ctx.paths.manifest, ctx.manifest);
    logger.nodeDone(label, durationMs);
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = getErrorMessage(err);
    setStage(ctx.manifest, stage, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      durationMs,
      error: message,
    });
    if (!ctx.manifest.errors.includes(message)) {
      ctx.manifest.errors.push(message);
    }
    await saveManifest(ctx.paths.manifest, ctx.manifest);
    logger.nodeFailed(label, message);
    throw err;
  }
}

/** Record a stage as deliberately skipped (dry-run / staged stop). */
export async function markStageSkipped(
  ctx: StoryRunContext,
  stage: StoryStage,
  reason: string,
): Promise<void> {
  setStage(ctx.manifest, stage, { status: "skipped", error: undefined });
  if (ctx.manifest.warnings.every((entry) => entry !== reason)) {
    ctx.manifest.warnings.push(reason);
  }
  await saveManifest(ctx.paths.manifest, ctx.manifest);
  logger.nodeSkipped(stageLabel(stage), reason);
}
