import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import type {
  AssetMode,
  SceneEntity,
  SourceAsset,
} from "../schemas/production.js";
import { AgentModel } from "../models/agent-model.js";
import {
  createDefaultSourceAssetSearcher,
  type SourceAssetSearcher,
  type SourceAssetOutcome,
} from "../providers/source-asset-search.js";
import { sourceEntityKey } from "../providers/source-asset-provider.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";

const DEFAULT_SEARCHER = createDefaultSourceAssetSearcher();

function getSearcher(config: RunnableConfig): SourceAssetSearcher {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (
    (inject.sourceAssetSearcher as SourceAssetSearcher) ?? DEFAULT_SEARCHER
  );
}

function normalizedEntities(scene: Scene): SceneEntity[] {
  return (scene.entities ?? []).map((entity) => ({
    ...entity,
    requiresSourceImage:
      entity.requiresSourceImage === true || entity.type === "person",
  }));
}

export function defaultAssetMode(scene: Scene): AssetMode {
  const entities = normalizedEntities(scene).filter(
    (entity) => entity.requiresSourceImage,
  );
  if (entities.length === 0) return "generated";
  return scene.assetMode === "source_composite" ||
    scene.assetMode === "source_edit"
    ? scene.assetMode
    : "source";
}

export async function assetStrategyNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: { scenes: Scene[]; sourceAssets: SourceAsset[] };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const startedAt = Date.now();
  const scenes = state.production?.scenes ?? [];
  const label = nodeLabel(AgentModel.AssetStrategy);
  logger.nodeStart(label);
  if (scenes.length === 0) {
    logger.nodeFailed(label, "No scenes to process");
    return {
      diagnostics: {
        errors: [`${AgentModel.AssetStrategy}: No scenes to process`],
      },
      execution: { currentNode: AgentModel.AssetStrategy },
    };
  }

  logger.nodePhase(label, "searching source assets");

  const searcher = getSearcher(config);
  const candidates = new Map<string, SourceAsset | undefined>();
  const allEntities = new Map<string, SceneEntity>();
  const diagnostics: Diagnostics = { errors: [], warnings: [] };

  for (const scene of scenes) {
    for (const entity of normalizedEntities(scene)) {
      if (entity.requiresSourceImage)
        allEntities.set(sourceEntityKey(entity), entity);
    }
  }

  for (const [key, entity] of allEntities) {
    logger.info("SourceAsset searching for entity", {
      entity: entity.name,
      type: entity.type,
    });
    const outcome: SourceAssetOutcome = await searcher.search(entity);

    switch (outcome.status) {
      case "ok": {
        candidates.set(key, outcome.asset);
        logger.info("SourceAsset found", {
          entity: entity.name,
          provider: outcome.provider,
          query: outcome.query,
          assetId: outcome.asset.id,
          durationMs: outcome.totalDurationMs,
        });
        break;
      }
      case "no_match": {
        candidates.set(key, undefined);
        const warning = `AssetStrategy: no usable source asset for "${entity.name}" (queries: ${outcome.queries.join(", ")})`;
        diagnostics.warnings?.push(warning);
        logger.warn(warning, {
          entity: entity.name,
          queries: outcome.queries,
          durationMs: outcome.totalDurationMs,
        });
        break;
      }
      case "provider_failure": {
        candidates.set(key, undefined);
        const warning = `AssetStrategy: source lookup failed for "${entity.name}" (${outcome.provider}: ${outcome.reason})`;
        diagnostics.warnings?.push(warning);
        logger.warn(warning, {
          entity: entity.name,
          provider: outcome.provider,
          reason: outcome.reason,
          durationMs: outcome.totalDurationMs,
        });
        break;
      }
    }
  }

  const sourceAssets = [...(state.production?.sourceAssets ?? [])];
  const byId = new Map(sourceAssets.map((asset) => [asset.id, asset]));
  const resolvedScenes = scenes.map((scene) => {
    const entities = normalizedEntities(scene);
    const sourceAssetIds = entities
      .filter((entity) => entity.requiresSourceImage)
      .map((entity) => candidates.get(sourceEntityKey(entity)))
      .filter((asset): asset is SourceAsset => !!asset)
      .map((asset) => {
        const entity = entities.find(
          (candidate) =>
            candidate.canonicalId === asset.entityId ||
            candidate.name === asset.entityId,
        );
        const normalized =
          entity && !asset.entityId
            ? { ...asset, entityId: entity.canonicalId ?? entity.name }
            : asset;
        byId.set(normalized.id, normalized);
        return normalized.id;
      });
    const mode =
      sourceAssetIds.length > 0 ? defaultAssetMode(scene) : "generated";
    return {
      ...scene,
      assetMode: mode,
      entities: entities.length > 0 ? entities : undefined,
      sourceAssetIds: sourceAssetIds.length > 0 ? sourceAssetIds : undefined,
    };
  });

  logger.nodeDone(label, Date.now() - startedAt);

  return {
    production: { scenes: resolvedScenes, sourceAssets: [...byId.values()] },
    diagnostics,
    execution: { currentNode: AgentModel.AssetStrategy },
  };
}
