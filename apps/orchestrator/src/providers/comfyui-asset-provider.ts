import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssetProvider, GenerateImageOptions, GenerateVideoOptions, AssetResult } from "./asset-provider.js";
import { config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";

const REQUEST_TIMEOUT_MS = 600_000;
const ASSETS_DIR = resolve("generated", "assets");

export class ComfyUIAssetProvider implements AssetProvider {
  async generateImage(opts: GenerateImageOptions): Promise<AssetResult> {
    const filename = opts.filename ?? `scene-${String(opts.sceneId).padStart(3, "0")}.png`;
    const dir = opts.runId ? resolve(ASSETS_DIR, opts.runId) : ASSETS_DIR;
    const filePath = resolve(dir, filename);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${config.imageProviderUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: opts.prompt }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error)?.name === "AbortError") {
        throw new PipelineError(
          "Image generation timed out after 10m",
          "ASSET_PROVIDER_ERROR",
        );
      }
      throw new PipelineError(
        `Image generation failed: ${(err as Error)?.message ?? String(err)}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new PipelineError(
        `Image generation failed: HTTP ${response.status} ${response.statusText}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      throw new PipelineError(
        `Unexpected content type: ${contentType}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (err) {
      throw new PipelineError(
        `Failed to read image response: ${(err as Error)?.message ?? String(err)}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    if (arrayBuffer.byteLength === 0) {
      throw new PipelineError(
        "Received empty image response",
        "ASSET_PROVIDER_ERROR",
      );
    }

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, Buffer.from(arrayBuffer));
    } catch (err) {
      throw new PipelineError(
        `Failed to save image: ${(err as Error)?.message ?? String(err)}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    return { url: filePath };
  }

  async generateVideo(_opts: GenerateVideoOptions): Promise<AssetResult> {
    throw new PipelineError(
      "Video generation not supported by ComfyUIAssetProvider",
      "ASSET_PROVIDER_ERROR",
    );
  }
}
