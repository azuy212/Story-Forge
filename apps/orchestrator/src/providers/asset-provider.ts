export interface GenerateImageOptions {
  prompt: string;
  sceneId: number;
  filename?: string;
  runId?: string;
  referenceImages?: AssetReference[];
  mode?: ImageGenerationMode;
}

export type ImageGenerationMode = "text_to_image" | "image_to_image" | "edit";

export interface AssetReference {
  id: string;
  path: string;
  mimeType?: string;
}

export interface GenerateVideoOptions {
  prompt: string;
  sceneId: number;
  filename?: string;
  runId?: string;
}

export interface AssetResult {
  url: string;
}

export interface AssetProvider {
  capabilities?: {
    referenceImages?: boolean;
    imageEditing?: boolean;
  };
  generateImage(opts: GenerateImageOptions): Promise<AssetResult>;
  generateVideo(opts: GenerateVideoOptions): Promise<AssetResult>;
}

import { ImageProviderAssetProvider } from "./image-provider-asset-provider.js";
import { StubAssetProvider } from "./stub-provider.js";
import { config } from "../utils/config.js";

export function createDefaultAssetProvider(): AssetProvider {
  return config.useRealProviders()
    ? new ImageProviderAssetProvider()
    : new StubAssetProvider();
}
