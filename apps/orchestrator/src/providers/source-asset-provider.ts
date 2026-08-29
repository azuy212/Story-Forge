import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import type { RunLogSink } from "../utils/run-log.js";

export interface SourceAssetSearchContext {
  sink?: RunLogSink | null;
  runId?: string;
}

export interface SourceAssetProvider {
  readonly name: string;
  search(
    entity: SceneEntity,
    query: string,
    deadlineMs?: number,
    context?: SourceAssetSearchContext,
  ): Promise<SourceAsset[]>;
}

export function sourceEntityKey(entity: SceneEntity): string {
  return `${entity.type}:${(entity.canonicalId ?? entity.name).trim().toLowerCase()}`;
}
