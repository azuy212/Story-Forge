export type AssetType = 'image' | 'video';

export interface MediaAsset {
  filename: string;
  buffer: Buffer;
}

export interface GenerationResult {
  prompt: string;
  assetType: AssetType;
  assets: MediaAsset[];
  fromCache: boolean;
}
