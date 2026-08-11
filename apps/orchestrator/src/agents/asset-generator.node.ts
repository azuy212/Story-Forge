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
import { getArtifactNamespace } from "../artifacts/context.js";
import type { Provider, SourceAsset } from "../schemas/production.js";
import { padSceneId } from "../utils/scene-id.js";
import { config as appConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

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

function allScenesGenerated(scenes: Scene[]): boolean {
  return scenes.filter((s) => s.generationPrompt).every((s) => !!s.assetUrl);
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
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
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

  if (scenes.length === 0) {
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
      validate: (artifact) => allScenesGenerated(artifact.scenes),
    },
    async () => {
      const errors: string[] = [];
      const withAsset = await mapWithConcurrency(
        plannedScenes,
        3,
        async (scene): Promise<Scene> => {
          if (!scene.generationPrompt || !scene.filename) {
            errors.push(
              `${AgentModel.AssetGenerator}: Scene ${scene.sceneId} missing generationPrompt or filename, skipping`,
            );
            return scene;
          }

          try {
            const assetType = scene.assetType ?? "image";
            const runId = getArtifactNamespace(config, state);
            const mode = scene.assetMode ?? "generated";
            const selectedSourceAssets = sourceAssetsFor(scene, sourceAssets);
            const references = referencesFor(selectedSourceAssets);

            if (
              assetType === "image" &&
              mode === "source" &&
              references.length > 0
            ) {
              return {
                ...scene,
                assetKind: "source-image" as const,
                assetUrl: references[0].path,
                assetGeneratedAt: new Date().toISOString(),
              } as Scene;
            }

            if (
              assetType === "image" &&
              (mode === "source_composite" || mode === "source_edit") &&
              references.length > 0
            ) {
              const supportsReferenceMode =
                provider.capabilities?.referenceImages === true &&
                (mode !== "source_edit" ||
                  provider.capabilities.imageEditing === true);
              if (!supportsReferenceMode) {
                logger.info(
                  "AssetGenerator reference capability unavailable; using source image",
                  {
                    sceneId: scene.sceneId,
                    mode,
                  },
                );
                return {
                  ...scene,
                  assetKind: "source-image" as const,
                  assetUrl: references[0].path,
                  assetGeneratedAt: new Date().toISOString(),
                } as Scene;
              }

              try {
                const assetResult = await provider.generateImage({
                  prompt: scene.generationPrompt,
                  sceneId: scene.sceneId,
                  filename: scene.filename,
                  runId,
                  referenceImages: references,
                  mode: mode === "source_edit" ? "edit" : "image_to_image",
                });
                return {
                  ...scene,
                  assetKind:
                    mode === "source_edit"
                      ? ("source-edit" as const)
                      : ("source-composite" as const),
                  assetUrl: assetResult.url,
                  assetGeneratedAt: new Date().toISOString(),
                } as Scene;
              } catch (error) {
                logger.info(
                  "AssetGenerator reference generation failed; using source image",
                  {
                    sceneId: scene.sceneId,
                    mode,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                );
                return {
                  ...scene,
                  assetKind: "source-image" as const,
                  assetUrl: references[0].path,
                  assetGeneratedAt: new Date().toISOString(),
                } as Scene;
              }
            }

            const assetResult =
              assetType === "video"
                ? await provider.generateVideo({
                    prompt: scene.generationPrompt,
                    sceneId: scene.sceneId,
                    filename: scene.filename,
                    runId,
                  })
                : await provider.generateImage({
                    prompt: scene.generationPrompt,
                    sceneId: scene.sceneId,
                    filename: scene.filename,
                    runId,
                  });

            return {
              ...scene,
              ...(assetType === "image"
                ? { assetKind: "generated-image" as const }
                : {}),
              assetUrl: assetResult.url,
              assetGeneratedAt: new Date().toISOString(),
            };
          } catch (err) {
            errors.push(
              `${AgentModel.AssetGenerator}: Scene ${scene.sceneId} generation failed: ${(err as Error)?.message ?? String(err)}`,
            );
            return scene;
          }
        },
      );

      return {
        data: errors.length > 0 ? null : { scenes: withAsset, sourceAssets },
        error: errors.length > 0 ? errors.join("\n") : undefined,
      };
    },
    config,
  );

  if (result.error) {
    const artifact = result.data ?? { scenes: plannedScenes, sourceAssets };
    return {
      production: artifact,
      diagnostics: {
        errors: [result.error],
      },
      execution: {
        currentNode: AgentModel.AssetGenerator,
      },
    };
  }

  return {
    production: result.data ?? { scenes: plannedScenes, sourceAssets },
    diagnostics: {},
    execution: {
      currentNode: AgentModel.AssetGenerator,
    },
  };
}
