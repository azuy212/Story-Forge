import { detectMediaExt, extToMime } from '../storage/asset-downloader.js';
import type { GenerationResult } from '../core/types.js';

export interface MediaPayload {
  filename: string;
  mime: string;
  base64: string;
}

/** Convert downloaded assets into the JSON response payload. */
export function buildMediaPayload(result: GenerationResult): MediaPayload[] {
  return result.assets.map((asset) => ({
    filename: asset.filename,
    mime: extToMime(detectMediaExt(asset.buffer, result.assetType)),
    base64: asset.buffer.toString('base64'),
  }));
}

/** MIME for a single asset, used by the non-JSON response branch. */
export function mediaMime(result: GenerationResult): string {
  return extToMime(detectMediaExt(result.assets[0].buffer, result.assetType));
}
