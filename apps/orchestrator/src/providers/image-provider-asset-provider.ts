import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AssetProvider,
  GenerateImageOptions,
  GenerateVideoOptions,
  AssetResult,
} from "./asset-provider.js";
import { config } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import {
  ImageGenerationProviderError,
  normalizeImageGenerationError,
  ImageGenerationFailureTypeEnum,
  type ImageGenerationFailureType,
} from "./image-generation-error.js";

const REQUEST_TIMEOUT_MS = 600_000;
const ASSETS_DIR = resolve("generated", "assets");

function mimeTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return "image/png";
}

interface ProviderErrorBody {
  error?: {
    type?: ImageGenerationFailureType;
    message?: string;
    rawMessage?: string;
    provider?: string;
    model?: string;
  };
}

/**
 * Parse a structured error body returned by the image-provider service. The
 * service (the Gemini adapter) is the only component that classifies
 * provider-specific failures; unknown/malformed bodies fall back to an
 * unclassified error so a rejection is never silently downgraded.
 */
function parseProviderErrorBody(
  body: unknown,
  status: number,
): {
  type: ImageGenerationFailureType;
  message: string;
  rawMessage?: string;
} | null {
  if (typeof body === "object" && body !== null) {
    const err = (body as ProviderErrorBody).error;
    const type = err?.type;
    const message = err?.message;
    if (
      (typeof type === "string" && type.length > 0) ||
      (typeof message === "string" && message.length > 0)
    ) {
      // Validate the type against the closed enum: a type the orchestrator
      // does not know must downgrade to `unknown` (fatal), never pass through
      // as a string that silently lands in the transient-retry branch.
      const parsedType =
        typeof type === "string" && type.length > 0
          ? ImageGenerationFailureTypeEnum.safeParse(type)
          : { success: false as const };
      return {
        type: parsedType.success ? parsedType.data : "unknown",
        message:
          typeof message === "string" && message.length > 0
            ? message
            : `Image-provider generation failed: HTTP ${status}`,
        rawMessage: err?.rawMessage,
      };
    }
  }
  return null;
}

export class ImageProviderAssetProvider implements AssetProvider {
  capabilities = { referenceImages: true, imageEditing: true };

  async generateImage(opts: GenerateImageOptions): Promise<AssetResult> {
    const filename =
      opts.filename ?? `scene-${String(opts.sceneId).padStart(3, "0")}.png`;
    const dir = opts.runId ? resolve(ASSETS_DIR, opts.runId) : ASSETS_DIR;
    const filePath = resolve(dir, filename);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      const referenceImages = opts.referenceImages?.length
        ? await Promise.all(
            opts.referenceImages.map(async (reference) => ({
              id: reference.id,
              filename:
                reference.path.split("/").pop() ?? `${reference.id}.png`,
              mime: reference.mimeType ?? mimeTypeFor(reference.path),
              base64: (await readFile(reference.path)).toString("base64"),
            })),
          )
        : undefined;
      const body = referenceImages
        ? {
            prompt: opts.prompt,
            type: "image",
            mode: opts.mode ?? "text_to_image",
            referenceImages,
          }
        : { prompt: opts.prompt };
      response = await fetch(`${config.imageProviderUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error)?.name === "AbortError") {
        throw new ImageGenerationProviderError(
          normalizeImageGenerationError({
            provider: "gemini",
            type: "timeout",
            message: "Image-provider generation timed out after 10m",
            originalPrompt: opts.prompt,
            sceneId: opts.sceneId,
          }),
        );
      }
      throw new ImageGenerationProviderError(
        normalizeImageGenerationError({
          provider: "gemini",
          type: "server_error",
          message: `Image-provider generation failed: ${(err as Error)?.message ?? String(err)}`,
          originalPrompt: opts.prompt,
          sceneId: opts.sceneId,
        }),
      );
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      const raw = await response.json().catch(() => null);
      const parsed = parseProviderErrorBody(raw, response.status);
      if (parsed) {
        throw new ImageGenerationProviderError(
          normalizeImageGenerationError({
            provider: "gemini",
            type: parsed.type,
            message: parsed.message,
            rawMessage: parsed.rawMessage,
            originalPrompt: opts.prompt,
            sceneId: opts.sceneId,
          }),
        );
      }
      throw new ImageGenerationProviderError(
        normalizeImageGenerationError({
          provider: "gemini",
          type: "unknown",
          message: `Image-provider generation failed: HTTP ${response.status} ${response.statusText}`,
          rawMessage: `HTTP ${response.status} ${response.statusText}`,
          originalPrompt: opts.prompt,
          sceneId: opts.sceneId,
        }),
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      throw new PipelineError(
        `Unexpected image-provider content type: ${contentType}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (err) {
      throw new PipelineError(
        `Failed to read image-provider response: ${(err as Error)?.message ?? String(err)}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    if (arrayBuffer.byteLength === 0) {
      throw new PipelineError(
        "Received empty image-provider response",
        "ASSET_PROVIDER_ERROR",
      );
    }

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, Buffer.from(arrayBuffer));
    } catch (err) {
      throw new PipelineError(
        `Failed to save image-provider result: ${(err as Error)?.message ?? String(err)}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    return { url: filePath };
  }

  async generateVideo(_opts: GenerateVideoOptions): Promise<AssetResult> {
    throw new PipelineError(
      "Video generation not supported by image-provider adapter",
      "ASSET_PROVIDER_ERROR",
    );
  }
}
