export type AssetType = 'image' | 'video';

export interface MediaAsset {
  filename: string;
  buffer: Buffer;
}

export interface ReferenceImage {
  id: string;
  filename: string;
  mime: string;
  base64: string;
}

export type GenerationMode = 'text_to_image' | 'image_to_image' | 'edit';

export interface GenerationOptions {
  mode?: GenerationMode;
  referenceImages?: ReferenceImage[];
  /**
   * Unique value appended to the cache key. Callers use it to force a fresh
   * generation without changing the prompt (for example a scene regeneration
   * or a gate-failure retry).
   */
  cacheNonce?: string;
}

export interface GenerationResult {
  prompt: string;
  assetType: AssetType;
  assets: MediaAsset[];
  fromCache: boolean;
}
