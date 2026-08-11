import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import { config } from "../utils/config.js";
import {
  FileSourceAssetCache,
  CachedSourceAssetProvider,
} from "./source-asset-cache.js";
import { WikimediaSourceAssetProvider } from "./wikimedia-source-asset-provider.js";

export interface SourceAssetProvider {
  search(entity: SceneEntity): Promise<SourceAsset[]>;
}

export function sourceEntityKey(entity: SceneEntity): string {
  return `${entity.type}:${(entity.canonicalId ?? entity.name).trim().toLowerCase()}`;
}

export function createDefaultSourceAssetProvider(): SourceAssetProvider {
  return new CachedSourceAssetProvider(
    new WikimediaSourceAssetProvider(),
    new FileSourceAssetCache(config.sourceAssetCacheDir()),
  );
}
