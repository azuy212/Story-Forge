import type {
  AssetProvider,
  GenerateImageOptions,
  GenerateVideoOptions,
  AssetResult,
} from "./asset-provider.js";

export class StubAssetProvider implements AssetProvider {
  capabilities = { referenceImages: false, imageEditing: false };

  async generateImage(opts: GenerateImageOptions): Promise<AssetResult> {
    return {
      url: `https://placeholder.local/${opts.filename ?? `scene-${String(opts.sceneId).padStart(3, "0")}.png`}`,
    };
  }

  async generateVideo(opts: GenerateVideoOptions): Promise<AssetResult> {
    return {
      url: `https://placeholder.local/${opts.filename ?? `scene-${String(opts.sceneId).padStart(3, "0")}.mp4`}`,
    };
  }
}
