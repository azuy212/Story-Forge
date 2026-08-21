import type { SceneEntity, SourceAsset } from "../schemas/production.js";

export interface SourceAssetProvider {
  readonly name: string;
  search(
    entity: SceneEntity,
    query: string,
    deadlineMs?: number,
  ): Promise<SourceAsset[]>;
}

export function sourceEntityKey(entity: SceneEntity): string {
  return `${entity.type}:${(entity.canonicalId ?? entity.name).trim().toLowerCase()}`;
}
