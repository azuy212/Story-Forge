import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import { AgentModel } from "../models/agent-model.js";
import type { AssetProvider } from "../providers/asset-provider.js";
import { createDefaultAssetProvider } from "../providers/asset-provider.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { getArtifactNamespace } from "../artifacts/context.js";
import type { Provider } from "../schemas/production.js";
import { padSceneId } from "../utils/scene-id.js";
import { config as appConfig } from "../utils/config.js";

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
    const assetType = resolveAssetType(scene.assetType);
    const cfg = configFor(assetType);
    const padded = padSceneId(scene.sceneId);

    return {
      ...scene,
      assetType,
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

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
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

  const result = await cacheNodeResult<Scene[]>(
    {
      type: "assets",
      node: AgentModel.AssetGenerator,
      key: {
        provider: provider.constructor.name,
        scenes: plannedScenes.map((s) => ({
          sceneId: s.sceneId,
          generationPrompt: s.generationPrompt,
          assetType: s.assetType,
          filename: s.filename,
        })),
      },
      validate: allScenesGenerated,
    },
    async () => {
      const errors: string[] = [];
      const withAsset = await mapWithConcurrency(
        plannedScenes,
        3,
        async (scene) => {
          if (!scene.generationPrompt || !scene.filename) {
            errors.push(
              `${AgentModel.AssetGenerator}: Scene ${scene.sceneId} missing generationPrompt or filename, skipping`,
            );
            return scene;
          }

          try {
            const assetType = scene.assetType ?? "image";
            const runId = getArtifactNamespace(config, state);
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
        data: errors.length > 0 ? null : withAsset,
        error: errors.length > 0 ? errors.join("\n") : undefined,
      };
    },
    config,
  );

  if (result.error) {
    return {
      production: { scenes: result.data ?? plannedScenes },
      diagnostics: {
        errors: [result.error],
      },
      execution: {
        currentNode: AgentModel.AssetGenerator,
      },
    };
  }

  return {
    production: { scenes: result.data ?? plannedScenes },
    diagnostics: {},
    execution: {
      currentNode: AgentModel.AssetGenerator,
    },
  };
}
