import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashObject } from "../artifacts/hash.js";
import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import type { SourceAssetProvider } from "./source-asset-provider.js";
import { sourceEntityKey } from "./source-asset-provider.js";

export interface SourceAssetCache {
  get(entity: SceneEntity, query: string): Promise<SourceAsset[] | null>;
  set(entity: SceneEntity, query: string, assets: SourceAsset[]): Promise<void>;
}

export class FileSourceAssetCache implements SourceAssetCache {
  constructor(private readonly directory: string) {}

  private pathFor(entity: SceneEntity, query: string): string {
    return join(
      this.directory,
      `${hashObject(`${sourceEntityKey(entity)}|${query}`)}.json`,
    );
  }

  async get(entity: SceneEntity, query: string): Promise<SourceAsset[] | null> {
    try {
      const raw = await readFile(this.pathFor(entity, query), "utf8");
      const value = JSON.parse(raw) as {
        key?: string;
        query?: string;
        assets?: SourceAsset[];
      };
      if (
        value.key !== sourceEntityKey(entity) ||
        value.query !== query ||
        !Array.isArray(value.assets)
      ) {
        return null;
      }
      return value.assets;
    } catch {
      return null;
    }
  }

  async set(
    entity: SceneEntity,
    query: string,
    assets: SourceAsset[],
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(entity, query);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify(
        {
          key: sourceEntityKey(entity),
          query,
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
  readonly name = "cached";

  constructor(
    private readonly provider: SourceAssetProvider,
    private readonly cache: SourceAssetCache,
  ) {}

  async search(
    entity: SceneEntity,
    query: string,
    deadlineMs?: number,
  ): Promise<SourceAsset[]> {
    const cached = await this.cache.get(entity, query);
    if (cached && cached.length > 0) return cached;
    const assets = await this.provider.search(entity, query, deadlineMs);
    if (assets.length > 0)
      await this.cache.set(entity, query, assets).catch(() => {});
    return assets;
  }
}
