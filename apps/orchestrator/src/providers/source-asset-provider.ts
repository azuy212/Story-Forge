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

/**
 * Stable cache key for a scene entity. The base identifier (type + canonical
 * id) is the entity identity; we additionally fold in any fields that change
 * the expected source asset shape so a resume that flips videoProfile, scene
 * asset type, or target resolution does not silently reuse a stale result.
 */
export function sourceEntityKey(entity: SceneEntity): string {
  const base = `${entity.type}:${(entity.canonicalId ?? entity.name).trim().toLowerCase()}`;
  const parts: string[] = [base];
  if (entity.resolution) {
    parts.push(`res=${entity.resolution.width}x${entity.resolution.height}`);
  }
  if (entity.minimumDurationSec !== undefined) {
    parts.push(`minDur=${entity.minimumDurationSec}`);
  }
  return parts.join("|");
}
