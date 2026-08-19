import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import { AgentModel } from "../models/agent-model.js";
import type {
  AssetProvider,
  AssetReference,
} from "../providers/asset-provider.js";
import { createDefaultAssetProvider } from "../providers/asset-provider.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { withTopic } from "../artifacts/context.js";
import type { Provider, SourceAsset } from "../schemas/production.js";
import {
  ImageGenerationProviderError,
  isFatalFailure,
  isImageGenerationProviderError,
  isRepairCandidate,
  normalizeImageGenerationError,
} from "../providers/image-generation-error.js";
import {
  IMAGE_TRANSIENT_MAX_ATTEMPTS,
  IMAGE_TRANSIENT_RETRY_DELAYS_MS,
  MAX_PROMPT_REPAIRS,
} from "../utils/constants.js";
import { padSceneId } from "../utils/scene-id.js";
import { config as appConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import {
  nodeStart,
  nodeDone,
  nodeFailed,
  nodeIncomplete,
} from "../utils/node-labels.js";

const DEFAULT_PROVIDER = createDefaultAssetProvider();

const ASSET_CONFIG = {
  image: { provider: "gpt-image" as Provider, extension: "png" },
  video: { provider: "runway" as Provider, extension: "mp4" },
} as const;

function configFor(assetType: Scene["assetType"]): {
  provider: Provider;
  extension: string;
} {
  return ASSET_CONFIG[assetType === "video" ? "video" : "image"];
}

/**
 * Normalize the scene's assetType before planning: video generation is not
 * implemented yet, so unless ENABLE_VIDEO_ASSETS is set, any "video" the LLM
 * emitted falls back to image. This prevents accidental calls to the
 * unimplemented video provider.
 */
function resolveAssetType(assetType: Scene["assetType"]): Scene["assetType"] {
  return appConfig.supportsVideoAssets() && assetType === "video"
    ? "video"
    : "image";
}

function buildPlan(scenes: Scene[]): Scene[] {
  return scenes.map((scene) => {
    const mode = scene.assetMode ?? "generated";
    const assetType =
      mode === "source" || mode === "source_composite" || mode === "source_edit"
        ? "image"
        : resolveAssetType(scene.assetType);
    const cfg = configFor(assetType);
    const padded = padSceneId(scene.sceneId);

    return {
      ...scene,
      assetType,
      assetMode: mode,
      assetId: scene.assetId ?? `asset-scene-${padded}`,
      provider: scene.provider ?? cfg.provider,
      generationMode: scene.generationMode ?? "generate",
      filename: scene.filename ?? `scene-${padded}.${cfg.extension}`,
      extension: scene.extension ?? cfg.extension,
    };
  });
}

function getAssetProvider(config: RunnableConfig): AssetProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.assetProvider as AssetProvider) ?? DEFAULT_PROVIDER;
}

/**
 * All scenes that have a prompt must be resolved (asset present) and none may
 * still be awaiting repair/retry/failure. Guards both artifact persistence
 * (constraint: never cache a partially-generated asset set) and graph
 * advance (the spine stays all-or-nothing / fail-closed).
 */
function allScenesResolved(scenes: Scene[]): boolean {
  const unresolved = scenes.some(
    (scene) =>
      scene.generationStatus === "prompt_repair" ||
      scene.generationStatus === "failed" ||
      scene.generationStatus === "retrying",
  );
  if (unresolved) return false;
  return scenes
    .filter((scene) => scene.generationPrompt)
    .every((scene) => !!scene.assetUrl);
}

interface AssetArtifact {
  scenes: Scene[];
  sourceAssets: SourceAsset[];
}

function sourceAssetsFor(
  scene: Scene,
  sourceAssets: SourceAsset[],
): SourceAsset[] {
  const ids = new Set(scene.sourceAssetIds ?? []);
  return sourceAssets.filter((asset) => ids.has(asset.id));
}

function referencesFor(assets: SourceAsset[]): AssetReference[] {
  return assets.flatMap((asset) =>
    asset.localPath
      ? [{ id: asset.id, path: asset.localPath, mimeType: asset.mimeType }]
      : [],
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function appendAttempt(
  attempts: Scene["promptAttempts"],
  entry: NonNullable<Scene["promptAttempts"]>[number],
): Scene["promptAttempts"] {
  return [...(attempts ?? []), entry];
}

function toProviderErrorInfo(
  error: ImageGenerationProviderError,
): Scene["providerError"] {
  return {
    provider: error.info.provider,
    model: error.info.model,
    type: error.info.type,
    message: error.info.message,
    rawMessage: error.info.rawMessage,
    retryable: error.info.retryable,
    originalPrompt: error.info.originalPrompt,
    timestamp: error.info.timestamp,
  };
}

function asGenerationError(
  err: unknown,
  scene: Scene,
  providerName: string,
): ImageGenerationProviderError {
  if (isImageGenerationProviderError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ImageGenerationProviderError(
    normalizeImageGenerationError({
      provider: providerName,
      type: "server_error",
      message,
      originalPrompt: scene.generationPrompt ?? "",
      sceneId: scene.sceneId,
    }),
  );
}

type GenerateOutcome =
  | { kind: "resolved"; scene: Scene }
  | { kind: "repair"; scene: Scene }
  | { kind: "failed"; scene: Scene }
  | { kind: "fatal"; error: string; scene?: Scene };

/**
 * Generate one scene's asset with failure classification:
 * - content_policy / invalid_prompt → prompt_repair (never retried against
 *   the same prompt; never consumes the transient budget).
 * - rate_limit / timeout / server_error → exponential backoff, then fail.
 * - authentication / invalid_request / unknown → fatal, aborts the whole batch.
 * Scenes that already have an asset (or are terminal) are skipped untouched,
 * so interrupted runs resume only the outstanding scenes.
 */
async function generateScene(
  scene: Scene,
  sourceAssets: SourceAsset[],
  provider: AssetProvider,
): Promise<GenerateOutcome> {
  if (scene.assetUrl) return { kind: "resolved", scene };
  if (scene.generationStatus === "failed") return { kind: "failed", scene };

  if (!scene.generationPrompt || !scene.filename) {
    return {
      kind: "fatal",
      error: `${AgentModel.AssetGenerator}: Scene ${scene.sceneId} missing generationPrompt or filename, skipping`,
    };
  }
  const prompt = scene.generationPrompt;

  const assetType = scene.assetType ?? "image";
  const mode = scene.assetMode ?? "generated";
  const selectedSourceAssets = sourceAssetsFor(scene, sourceAssets);
  const references = referencesFor(selectedSourceAssets);

  if (assetType === "image" && mode === "source" && references.length > 0) {
    return {
      kind: "resolved",
      scene: {
        ...scene,
        assetKind: "source-image" as const,
        assetUrl: references[0].path,
        assetGeneratedAt: new Date().toISOString(),
        generationStatus: "complete" as const,
      },
    };
  }

  const referenceMode =
    assetType === "image" &&
    (mode === "source_composite" || mode === "source_edit") &&
    references.length > 0;

  if (referenceMode) {
    const supportsReferenceMode =
      provider.capabilities?.referenceImages === true &&
      (mode !== "source_edit" || provider.capabilities.imageEditing === true);
    if (!supportsReferenceMode) {
      // Deliberate, capability-based fallback: this provider cannot do
      // reference generation, so the source image is the safe substitute.
      // A generation ERROR is never swallowed here — reference-mode errors
      // flow through the same classification as plain generation below.
      logger.info(
        "AssetGenerator reference capability unavailable; using source image",
        {
          sceneId: scene.sceneId,
          mode,
        },
      );
      return {
        kind: "resolved",
        scene: {
          ...scene,
          assetKind: "source-image" as const,
          assetUrl: references[0].path,
          assetGeneratedAt: new Date().toISOString(),
          generationStatus: "complete" as const,
        },
      };
    }
  }

  const referenceImages = referenceMode ? references : undefined;
  const referenceModeParam = referenceMode
    ? mode === "source_edit"
      ? ("edit" as const)
      : ("image_to_image" as const)
    : undefined;

  let lastError: ImageGenerationProviderError | null = null;
  let nextAttempt = (scene.promptAttempts?.length ?? 0) + 1;
  // Durable per-scene state: a scene being generated reads as `generating`,
  // and a scene backing off between transient retries reads as `retrying`,
  // so an interrupted run shows where generation stopped instead of a bare
  // `pending`. Terminal outcomes overwrite these on the way out.
  scene = { ...scene, generationStatus: "generating" as const };

  for (let attempt = 1; attempt <= IMAGE_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      const assetResult =
        assetType === "video"
          ? await provider.generateVideo({
              prompt,
              sceneId: scene.sceneId,
              filename: scene.filename,
            })
          : await provider.generateImage({
              prompt,
              sceneId: scene.sceneId,
              filename: scene.filename,
              ...(referenceImages && referenceImages.length > 0
                ? { referenceImages, mode: referenceModeParam }
                : {}),
            });

      return {
        kind: "resolved",
        scene: {
          ...scene,
          ...(assetType === "image"
            ? {
                assetKind: referenceMode
                  ? mode === "source_edit"
                    ? ("source-edit" as const)
                    : ("source-composite" as const)
                  : ("generated-image" as const),
              }
            : {}),
          assetUrl: assetResult.url,
          assetGeneratedAt: new Date().toISOString(),
          generationStatus: "complete" as const,
          promptAttempts: appendAttempt(scene.promptAttempts, {
            attempt: nextAttempt++,
            prompt,
            status: "success",
          }),
        },
      };
    } catch (error) {
      const genError = asGenerationError(
        error,
        scene,
        scene.provider ?? "unknown",
      );
      lastError = genError;

      if (isFatalFailure(genError.info.type)) {
        logger.error("AssetGenerator fatal provider error", {
          sceneId: scene.sceneId,
          type: genError.info.type,
          message: genError.info.message,
        });
        return {
          kind: "fatal",
          error: `${AgentModel.AssetGenerator}: Scene ${scene.sceneId} fatal provider error (${genError.info.type}): ${genError.info.message}`,
          scene: {
            ...scene,
            generationStatus: "failed" as const,
            failureType: genError.info.type,
            providerError: toProviderErrorInfo(genError),
          },
        };
      }

      const rejectedAttempt = {
        attempt: nextAttempt++,
        prompt,
        status: "rejected" as const,
        errorType: genError.info.type,
        providerMessage: genError.info.message,
      };

      if (isRepairCandidate(genError.info.type)) {
        logger.warn(
          "AssetGenerator provider rejected prompt; routing to repair",
          {
            sceneId: scene.sceneId,
            type: genError.info.type,
            message: genError.info.message,
          },
        );
        const repairBudgetExhausted =
          (scene.repairCount ?? 0) >= MAX_PROMPT_REPAIRS;
        return {
          kind: repairBudgetExhausted ? "failed" : "repair",
          scene: {
            ...scene,
            generationStatus: repairBudgetExhausted
              ? ("failed" as const)
              : ("prompt_repair" as const),
            failureType: repairBudgetExhausted
              ? ("unresolved_provider_rejection" as const)
              : undefined,
            originalPrompt: scene.originalPrompt ?? scene.generationPrompt,
            providerError: toProviderErrorInfo(genError),
            promptAttempts: appendAttempt(
              scene.promptAttempts,
              rejectedAttempt,
            ),
          },
        };
      }

      // Transient failure: record the attempt and back off before retrying
      // the SAME prompt.
      scene = {
        ...scene,
        promptAttempts: appendAttempt(scene.promptAttempts, rejectedAttempt),
        generationStatus: "retrying" as const,
      };

      if (attempt < IMAGE_TRANSIENT_MAX_ATTEMPTS) {
        const delay = IMAGE_TRANSIENT_RETRY_DELAYS_MS[attempt - 1];
        logger.warn("AssetGenerator transient provider failure, backing off", {
          sceneId: scene.sceneId,
          type: genError.info.type,
          attempt,
          delayMs: delay,
        });
        await sleep(delay);
      }
    }
  }

  logger.error("AssetGenerator provider unavailable after retries", {
    sceneId: scene.sceneId,
    type: lastError?.info.type,
    message: lastError?.info.message,
  });
  return {
    kind: "failed",
    scene: {
      ...scene,
      generationStatus: "failed" as const,
      failureType: "provider_unavailable",
      providerError: lastError ? toProviderErrorInfo(lastError) : undefined,
    },
  };
}

export async function assetGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: { scenes: Scene[] };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const scenes = state.production?.scenes ?? [];
  const sourceAssets = state.production?.sourceAssets ?? [];
  const provider = getAssetProvider(config);

  logger.info(nodeStart(AgentModel.AssetGenerator), {
    scenes: scenes.length,
    provider: provider.constructor.name,
  });

  if (scenes.length === 0) {
    logger.warn(nodeFailed(AgentModel.AssetGenerator), {
      error: "No scenes to generate assets for",
    });
    return {
      diagnostics: {
        errors: [
          `${AgentModel.AssetGenerator}: No scenes to generate assets for`,
        ],
      },
      execution: {
        currentNode: AgentModel.AssetGenerator,
      },
    };
  }

  const plannedScenes = buildPlan(scenes);

  let computedArtifact: AssetArtifact | null = null;
  let fatalError: string | undefined;

  const result = await cacheNodeResult<AssetArtifact>(
    {
      type: "assets",
      node: AgentModel.AssetGenerator,
      key: {
        provider: provider.constructor.name,
        scenes: plannedScenes.map((s) => ({
          sceneId: s.sceneId,
          generationPrompt: s.generationPrompt,
          assetType: s.assetType,
          assetMode: s.assetMode,
          sourceAssetIds: s.sourceAssetIds,
          sourceAssets: sourceAssets.map((asset) => ({
            id: asset.id,
            url: asset.url,
            source: asset.source,
            license: asset.license,
            licenseUrl: asset.licenseUrl,
            attribution: asset.attribution,
            sourcePageUrl: asset.sourcePageUrl,
            localPath: asset.localPath,
          })),
          filename: s.filename,
        })),
      },
      validate: (artifact) => allScenesResolved(artifact.scenes),
    },
    async () => {
      const results: Scene[] = [];
      try {
        // mapWithConcurrency settles every worker (Promise.all) before this
        // block returns, so an in-flight worker's write always lands before
        // `results` is handed to the graph — no late-write race.
        await mapWithConcurrency(
          plannedScenes,
          3,
          async (scene, index): Promise<void> => {
            const outcome = await generateScene(scene, sourceAssets, provider);
            switch (outcome.kind) {
              case "fatal":
                // Preserve the fatal scene (marked failed) and anything
                // already generated: an auth wipe-out aborts the batch, but
                // the finished scenes and the failure reason survive.
                fatalError = outcome.error;
                results[index] = outcome.scene ?? {
                  ...scene,
                  generationStatus: "failed" as const,
                  failureType: "provider_error",
                };
                throw new Error(outcome.error);
              case "resolved":
              case "repair":
              case "failed":
                results[index] = outcome.scene;
            }
          },
        );
      } catch (error) {
        fatalError = error instanceof Error ? error.message : String(error);
        // Fill any scenes that never ran with their plan so downstream nodes
        // see the complete batch, not a partial list with holes.
        for (let i = 0; i < plannedScenes.length; i++) {
          if (!results[i]) results[i] = plannedScenes[i];
        }
        computedArtifact = { scenes: results, sourceAssets };
        return { data: null, error: fatalError };
      }

      computedArtifact = { scenes: results, sourceAssets };
      const complete = allScenesResolved(results);
      // Only a fully-resolved asset set is persisted; intermediate repair
      // states flow through the graph state instead.
      return { data: complete ? computedArtifact : null, error: undefined };
    },
    withTopic(config, state),
  );

  if (fatalError) {
    logger.error(nodeFailed(AgentModel.AssetGenerator), { error: fatalError });
    const fatalArtifact: AssetArtifact = computedArtifact ?? {
      scenes: plannedScenes,
      sourceAssets,
    };
    return {
      production: fatalArtifact,
      diagnostics: {
        errors: [fatalError],
      },
      execution: {
        currentNode: AgentModel.AssetGenerator,
      },
    };
  }

  const artifact =
    result.data ??
    computedArtifact ??
    ({ scenes: plannedScenes, sourceAssets } satisfies AssetArtifact);

  const warnings = artifact.scenes.flatMap((scene) => {
    if (scene.generationStatus === "prompt_repair") {
      return [
        `${AgentModel.AssetGenerator}: Scene ${scene.sceneId} prompt rejected by provider (${scene.providerError?.type ?? "unknown"}). ${scene.providerError?.message ?? ""}`,
      ];
    }
    if (scene.generationStatus === "failed") {
      return [
        `${AgentModel.AssetGenerator}: Scene ${scene.sceneId} failed (${scene.failureType ?? "unknown"}). ${scene.providerError?.message ?? ""}`,
      ];
    }
    return [];
  });

  const unresolved = artifact.scenes.filter(
    (scene) =>
      scene.generationStatus === "prompt_repair" ||
      scene.generationStatus === "failed" ||
      scene.generationStatus === "retrying",
  ).length;
  if (unresolved > 0) {
    logger.warn(nodeIncomplete(AgentModel.AssetGenerator), {
      unresolved,
      total: artifact.scenes.length,
    });
  } else {
    logger.info(nodeDone(AgentModel.AssetGenerator), {
      scenes: artifact.scenes.length,
    });
  }

  return {
    production: artifact,
    diagnostics: {
      warnings,
    },
    execution: {
      currentNode: AgentModel.AssetGenerator,
    },
  };
}
