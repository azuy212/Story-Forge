export interface GenerateImageOptions {
  prompt: string;
  sceneId: number;
  filename?: string;
  runId?: string;
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
  generateImage(opts: GenerateImageOptions): Promise<AssetResult>;
  generateVideo(opts: GenerateVideoOptions): Promise<AssetResult>;
}

import { ComfyUIAssetProvider } from "./comfyui-asset-provider.js";
import { StubAssetProvider } from "./stub-provider.js";
import { config } from "../utils/config.js";

export function createDefaultAssetProvider(): AssetProvider {
  return config.useRealProviders()
    ? new ComfyUIAssetProvider()
    : new StubAssetProvider();
}
