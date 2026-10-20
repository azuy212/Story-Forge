import { copyFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { hashObject } from "../artifacts/hash.js";
import { PipelineError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  IMAGE_TRANSIENT_MAX_ATTEMPTS,
  IMAGE_TRANSIENT_RETRY_DELAYS_MS,
} from "../utils/constants.js";
import {
  isImageGenerationProviderError,
  isRepairCandidate,
  isRetryableFailure,
} from "../providers/image-generation-error.js";
import type {
  AssetProvider,
  AssetReference,
} from "../providers/asset-provider.js";
import {
  hashFile,
  meanVariance,
  probeStreams,
  readGraySample,
} from "./media.js";
import { sceneImagePath } from "./paths.js";
import type { JobPaths } from "./paths.js";
import type { ResolvedStoryConfig, StoryScene } from "./types.js";

/**
 * S5 images: one still per scene, validated before it can be used.
 *
 * Every generated file must decode, meet the resolution and aspect gates
 * (DP4), carry real pixel variance (not blank), and be distinct from every
 * other scene's still. A provider prompt refusal gets exactly ONE logged
 * softening retry for the same scene; transient failures reuse the shared
 * retry budget. A scene that finally fails is recorded `failed` and the job
 * stops there, resumable for only the failed scenes.
 */

/** Minimum luminance variance below which a still is considered blank. */
export const MIN_LUMINANCE_VARIANCE = 8;

export interface ImageValidationIssue {
  message: string;
}

export interface ImageValidationResult {
  width: number;
  height: number;
  aspect: number;
  luminanceVariance: number;
}

export async function validateSceneImage(
  path: string,
  options: {
    minWidth: number;
    minHeight: number;
    minAspect: number;
    maxAspect: number;
    workDir: string;
    tag: string;
  },
): Promise<
  { ok: true; result: ImageValidationResult } | { ok: false; issues: string[] }
> {
  const issues: string[] = [];

  let info;
  try {
    info = await stat(path);
  } catch {
    return { ok: false, issues: [`image file is missing: ${path}`] };
  }
  if (info.size === 0) issues.push("image file is empty");

  let width = 0;
  let height = 0;
  try {
    const streams = await probeStreams(path);
    const video = streams.find((stream) => stream.type === "video");
    width = video?.width ?? 0;
    height = video?.height ?? 0;
  } catch {
    issues.push("image does not decode with ffprobe");
  }

  if (width === 0 || height === 0) {
    issues.push("image has no decodable video stream");
  } else {
    if (width < options.minWidth || height < options.minHeight) {
      issues.push(
        `image is ${width}x${height}; the gate requires at least ${options.minWidth}x${options.minHeight}`,
      );
    }
  }

  const aspect = height > 0 ? width / height : 0;
  if (
    aspect > 0 &&
    (aspect < options.minAspect || aspect > options.maxAspect)
  ) {
    issues.push(
      `image aspect ratio is ${aspect.toFixed(3)}; expected ${options.minAspect}–${options.maxAspect} so the 16:9 cover-crop is not severe`,
    );
  }

  let luminanceVariance = 0;
  if (width > 0 && height > 0) {
    try {
      const sample = await readGraySample(path, {
        width: 32,
        height: 32,
        workDir: options.workDir,
        tag: options.tag,
      });
      luminanceVariance = meanVariance(sample);
      if (luminanceVariance < MIN_LUMINANCE_VARIANCE) {
        issues.push(
          `image is effectively blank (luminance variance ${luminanceVariance.toFixed(2)} < ${MIN_LUMINANCE_VARIANCE})`,
        );
      }
    } catch {
      issues.push("image could not be sampled for blank detection");
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, result: { width, height, aspect, luminanceVariance } };
}

/** Deterministic prompt softening for a provider refusal (one retry only). */
export function softenPrompt(prompt: string): string {
  return prompt
    .replace(
      /\b(blood|bloody|gore|corpse|dead body|killing|killed|murder|stab|wound|suffering)\b/gi,
      "tense moment",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .concat(
      "\n\nDepict the moment calmly and non-graphically, suitable for young children.",
    );
}

export interface ImageStageOptions {
  scenes: StoryScene[];
  paths: JobPaths;
  config: ResolvedStoryConfig;
  assetProvider: AssetProvider;
  runId: string;
  workDir: string;
  /** Recorded on each image for provenance (defaults to the real provider). */
  providerLabel?: string;
  /** Optional shared reference image (character sheet) for every scene. */
  referenceImage?: AssetReference;
  dryRun?: boolean;
}

export interface ImageStageResult {
  generated: number;
  reused: number;
  failed: string[];
  /**
   * Set when the provider reported a spent image quota. The run stops at once
   * instead of waiting out the remaining scenes, and a rerun after the refill
   * generates only the scenes still missing an image.
   */
  quotaExhausted?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function generateOnce(
  assetProvider: AssetProvider,
  options: {
    prompt: string;
    sceneId: number;
    filename: string;
    runId: string;
    referenceImage?: AssetReference;
  },
): Promise<string> {
  const result = await assetProvider.generateImage({
    prompt: options.prompt,
    sceneId: options.sceneId,
    filename: options.filename,
    runId: options.runId,
    ...(options.referenceImage
      ? {
          referenceImages: [options.referenceImage],
          mode: "image_to_image" as const,
        }
      : {}),
  });
  return result.url;
}

export async function runImageStage(
  options: ImageStageOptions,
): Promise<ImageStageResult> {
  const { scenes, paths, config, assetProvider, runId, workDir } = options;
  const result: ImageStageResult = { generated: 0, reused: 0, failed: [] };
  const seenHashes = new Map<string, number>();

  const concurrency = Math.max(1, config.imageConcurrency);
  const queue = [...scenes];

  const worker = async (): Promise<void> => {
    for (;;) {
      if (result.quotaExhausted) return;
      const scene = queue.shift();
      if (!scene) return;
      await processScene(scene);
    }
  };

  async function processScene(scene: StoryScene): Promise<void> {
    if (!scene.imagePrompt) {
      scene.status.image = "failed";
      scene.warnings.push("scene has no composed image prompt");
      result.failed.push(`scene ${scene.sceneId}: no image prompt`);
      return;
    }
    const promptHash = hashObject(scene.imagePrompt);
    const target = sceneImagePath(paths, scene.sceneId);

    if (
      scene.status.image === "done" &&
      scene.image &&
      scene.image.promptHash === promptHash
    ) {
      try {
        const info = await stat(scene.image.path);
        if (info.size > 0) {
          const fileHash = await hashFile(scene.image.path);
          const previous = seenHashes.get(fileHash);
          if (previous !== undefined) {
            scene.status.image = "failed";
            scene.warnings.push(
              `image is byte-identical to scene ${previous}'s image`,
            );
            result.failed.push(
              `scene ${scene.sceneId}: duplicate of scene ${previous}`,
            );
            return;
          }
          seenHashes.set(fileHash, scene.sceneId);
          result.reused += 1;
          return;
        }
      } catch {
        // fall through to regeneration
      }
    }

    if (options.dryRun) return;

    const filename = `scene-${String(scene.sceneId).padStart(3, "0")}.png`;
    let prompt = scene.imagePrompt;
    let softenedFrom: string | undefined;
    let attempts = 0;
    let downloaded: string | undefined;

    try {
      for (let attempt = 0; attempt < IMAGE_TRANSIENT_MAX_ATTEMPTS; attempt++) {
        attempts += 1;
        try {
          downloaded = await generateOnce(assetProvider, {
            prompt,
            sceneId: scene.sceneId,
            filename,
            runId,
            referenceImage: options.referenceImage,
          });
          break;
        } catch (err) {
          if (!isImageGenerationProviderError(err)) throw err;
          const type = err.info.type;
          if (isRepairCandidate(type) && !softenedFrom) {
            // Exactly one logged softening retry for this scene.
            softenedFrom = prompt;
            prompt = softenPrompt(prompt);
            logger.warn(
              `Story scene ${scene.sceneId}: image provider refused the prompt; retrying once with a softened prompt`,
              { reason: err.info.message },
            );
            continue;
          }
          if (
            isRetryableFailure(type) &&
            attempt < IMAGE_TRANSIENT_MAX_ATTEMPTS - 1
          ) {
            const delay = IMAGE_TRANSIENT_RETRY_DELAYS_MS[attempt] ?? 2000;
            await sleep(delay);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      scene.status.image = "failed";
      const message = (err as Error)?.message ?? String(err);
      scene.warnings.push(`image generation failed: ${message}`);
      result.failed.push(`scene ${scene.sceneId}: ${message}`);
      if (
        isImageGenerationProviderError(err) &&
        err.info.type === "quota_exhausted"
      ) {
        result.quotaExhausted = true;
      }
      return;
    }

    if (!downloaded) {
      scene.status.image = "failed";
      scene.warnings.push("image generation produced no file");
      result.failed.push(`scene ${scene.sceneId}: no file produced`);
      return;
    }

    // Persist into the job's own images/ directory (deterministic mapping).
    if (resolve(downloaded) !== target) {
      await copyFile(downloaded, target);
    }

    const validation = await validateSceneImage(target, {
      minWidth: config.imageMinWidth,
      minHeight: config.imageMinHeight,
      minAspect: config.imageMinAspect,
      maxAspect: config.imageMaxAspect,
      workDir,
      tag: `scene-${scene.sceneId}`,
    });

    if (!validation.ok) {
      scene.status.image = "failed";
      scene.warnings.push(...validation.issues);
      result.failed.push(
        `scene ${scene.sceneId}: ${validation.issues.join("; ")}`,
      );
      return;
    }

    const fileHash = await hashFile(target);
    const previous = seenHashes.get(fileHash);
    if (previous !== undefined) {
      scene.status.image = "failed";
      scene.warnings.push(
        `image is byte-identical to scene ${previous}'s image`,
      );
      result.failed.push(
        `scene ${scene.sceneId}: duplicate of scene ${previous}`,
      );
      return;
    }
    seenHashes.set(fileHash, scene.sceneId);

    const byteSize = (await stat(target)).size;
    scene.image = {
      path: target,
      prompt,
      ...(softenedFrom ? { softenedFrom } : {}),
      provider: options.providerLabel ?? "image-provider",
      attempts,
      // Hash of the PLANNED prompt, not the possibly-softened one, so a
      // resume recognizes this image as current.
      promptHash,
      ...(options.referenceImage
        ? { referenceImage: options.referenceImage.path }
        : {}),
      byteSize,
      width: validation.result.width,
      height: validation.result.height,
      aspect: Math.round(validation.result.aspect * 1000) / 1000,
      luminanceVariance:
        Math.round(validation.result.luminanceVariance * 100) / 100,
      generatedAt: new Date().toISOString(),
    };
    scene.status.image = "done";
    result.generated += 1;
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, scenes.length)) },
      () => worker(),
    ),
  );

  return result;
}

export async function readImageDimensions(
  path: string,
): Promise<{ width: number; height: number }> {
  const streams = await probeStreams(path);
  const video = streams.find((stream) => stream.type === "video");
  if (!video || !video.width || !video.height) {
    throw new PipelineError(
      `Could not read image dimensions from ${path}`,
      "STORY_MEDIA_ERROR",
    );
  }
  return { width: video.width, height: video.height };
}

/** Build the optional shared character-sheet reference image. */
export async function buildCharacterSheetReference(options: {
  assetProvider: AssetProvider;
  prompt: string;
  path: string;
  runId: string;
}): Promise<AssetReference | undefined> {
  try {
    await stat(options.path);
    return { id: "character-sheet", path: options.path, mimeType: "image/png" };
  } catch {
    // Not generated yet.
  }
  try {
    const result = await options.assetProvider.generateImage({
      prompt: options.prompt,
      sceneId: 0,
      filename: options.path,
      runId: options.runId,
    });
    return { id: "character-sheet", path: result.url, mimeType: "image/png" };
  } catch (err) {
    logger.warn("Character sheet generation failed; continuing without it", {
      error: (err as Error)?.message ?? String(err),
    });
    return undefined;
  }
}

/** Read a small file's bytes (exported for tests that assert on outputs). */
export async function readBytes(path: string): Promise<Buffer> {
  return readFile(path);
}
