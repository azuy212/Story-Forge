import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashObject } from "../artifacts/hash.js";
import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import type { SourceAssetProvider } from "./source-asset-provider.js";
import { sourceEntityKey } from "./source-asset-provider.js";

export interface SourceAssetCache {
  get(entity: SceneEntity): Promise<SourceAsset[] | null>;
  set(entity: SceneEntity, assets: SourceAsset[]): Promise<void>;
}

export class FileSourceAssetCache implements SourceAssetCache {
  constructor(private readonly directory: string) {}

  private pathFor(entity: SceneEntity): string {
    return join(this.directory, `${hashObject(sourceEntityKey(entity))}.json`);
  }

  async get(entity: SceneEntity): Promise<SourceAsset[] | null> {
    try {
      const raw = await readFile(this.pathFor(entity), "utf8");
      const value = JSON.parse(raw) as { key?: string; assets?: SourceAsset[] };
      if (
        value.key !== sourceEntityKey(entity) ||
        !Array.isArray(value.assets)
      ) {
        return null;
      }
      return value.assets;
    } catch {
      return null;
    }
  }

  async set(entity: SceneEntity, assets: SourceAsset[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(entity);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify(
        {
          key: sourceEntityKey(entity),
          assets,
          cachedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    await rename(temporary, target);
  }
}

export class CachedSourceAssetProvider implements SourceAssetProvider {
  constructor(
    private readonly provider: SourceAssetProvider,
    private readonly cache: SourceAssetCache,
  ) {}

  async search(entity: SceneEntity): Promise<SourceAsset[]> {
    const cached = await this.cache.get(entity);
    if (cached) return cached;
    const assets = await this.provider.search(entity);
    await this.cache.set(entity, assets).catch(() => {});
    return assets;
  }
}
