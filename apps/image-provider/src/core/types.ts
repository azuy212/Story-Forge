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
}

export interface GenerationResult {
  prompt: string;
  assetType: AssetType;
  assets: MediaAsset[];
  fromCache: boolean;
}
