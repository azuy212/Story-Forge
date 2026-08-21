import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import type { SourceAssetProvider } from "./source-asset-provider.js";
import type { SourceAssetCache } from "./source-asset-cache.js";
import { FileSourceAssetCache } from "./source-asset-cache.js";
import { WikimediaSourceAssetProvider } from "./wikimedia-source-asset-provider.js";
import { UnsplashSourceAssetProvider } from "./unsplash-source-asset-provider.js";
import { PexelsSourceAssetProvider } from "./pexels-source-asset-provider.js";
import { TYPE_HINT, selectBestSourceAsset } from "./source-asset-selection.js";
import { materializeSourceAsset } from "./source-asset-materializer.js";
import { config as appConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

export type { SourceAssetProvider };

export type SourceAssetOutcome =
  | {
      status: "ok";
      asset: SourceAsset;
      provider: string;
      query: string;
      totalDurationMs: number;
    }
  | {
      status: "no_match";
      queries: string[];
      totalDurationMs: number;
    }
  | {
      status: "provider_failure";
      provider: string;
      reason: string;
      totalDurationMs: number;
    };

export interface SourceAssetSearcher {
  search(entity: SceneEntity): Promise<SourceAssetOutcome>;
}

function buildQueries(entity: SceneEntity): string[] {
  const name = entity.name.trim();
  const hint = TYPE_HINT[entity.type] ?? "";
  const queries = [name];
  if (hint) queries.push(`${name} ${hint}`);
  return queries;
}

export class FallbackSourceAssetSearcher implements SourceAssetSearcher {
  constructor(
    private readonly providers: SourceAssetProvider[],
    private readonly cache: SourceAssetCache | null,
    private readonly deadlineMs: number,
  ) {}

  async search(entity: SceneEntity): Promise<SourceAssetOutcome> {
    const startedAt = Date.now();
    const deadline = startedAt + this.deadlineMs;
    const queries = buildQueries(entity);
    let sawFailure = false;
    let lastFailureReason = "";

    for (const query of queries) {
      for (const provider of this.providers) {
        if (Date.now() >= deadline) {
          logger.warn("SourceAsset search deadline exceeded", {
            entity: entity.name,
            provider: provider.name,
            query,
            reason: "deadline_exceeded",
          });
          return {
            status: "provider_failure",
            provider: provider.name,
            reason: "deadline_exceeded",
            totalDurationMs: Date.now() - startedAt,
          };
        }

        let assets: SourceAsset[];
        try {
          if (this.cache) {
            const cached = await this.cache.get(entity, query);
            assets = cached && cached.length > 0 ? cached : [];
            if (assets.length === 0) {
              assets = await provider.search(entity, query, deadline);
              if (assets.length > 0) {
                await this.cache.set(entity, query, assets).catch(() => {});
              }
            }
          } else {
            assets = await provider.search(entity, query, deadline);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          sawFailure = true;
          lastFailureReason = reason;
          logger.warn("SourceAsset provider search failed", {
            entity: entity.name,
            provider: provider.name,
            query,
            reason,
            durationMs: Date.now() - startedAt,
          });
          continue;
        }

        if (assets.length === 0) continue;

        const selected = selectBestSourceAsset(entity, assets);
        if (!selected) continue;

        if (Date.now() >= deadline) {
          logger.warn(
            "SourceAsset materialization deadline exceeded before start",
            {
              entity: entity.name,
              provider: provider.name,
              query,
            },
          );
          return {
            status: "provider_failure",
            provider: provider.name,
            reason: "deadline_exceeded",
            totalDurationMs: Date.now() - startedAt,
          };
        }

        try {
          const materialized = await materializeSourceAsset(
            selected,
            appConfig.sourceAssetCacheDir(),
            deadline,
          );
          logger.info("SourceAsset materialized", {
            entity: entity.name,
            provider: provider.name,
            query,
            assetId: materialized.id,
            totalDurationMs: Date.now() - startedAt,
          });
          return {
            status: "ok",
            asset: materialized,
            provider: provider.name,
            query,
            totalDurationMs: Date.now() - startedAt,
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (Date.now() >= deadline || reason.includes("deadline")) {
            logger.warn("SourceAsset materialization deadline exceeded", {
              entity: entity.name,
              provider: provider.name,
              query,
              reason,
            });
            return {
              status: "provider_failure",
              provider: provider.name,
              reason: "deadline_exceeded",
              totalDurationMs: Date.now() - startedAt,
            };
          }
          logger.warn("SourceAsset materialization failed", {
            entity: entity.name,
            provider: provider.name,
            query,
            reason,
          });
          continue;
        }
      }
    }

    if (sawFailure) {
      return {
        status: "provider_failure",
        provider: "multiple",
        reason: lastFailureReason || "all_providers_failed",
        totalDurationMs: Date.now() - startedAt,
      };
    }

    return {
      status: "no_match",
      queries,
      totalDurationMs: Date.now() - startedAt,
    };
  }
}

export function createDefaultSourceAssetSearcher(): SourceAssetSearcher {
  const providers: SourceAssetProvider[] = [new WikimediaSourceAssetProvider()];

  const unsplashKey = appConfig.unsplashAccessKey();
  if (unsplashKey) {
    providers.push(new UnsplashSourceAssetProvider(unsplashKey));
  }

  const pexelsKey = appConfig.pexelsApiKey();
  if (pexelsKey) {
    providers.push(new PexelsSourceAssetProvider(pexelsKey));
  }

  return new FallbackSourceAssetSearcher(
    providers,
    new FileSourceAssetCache(appConfig.sourceAssetCacheDir()),
    appConfig.sourceAssetDeadlineMs(),
  );
}
