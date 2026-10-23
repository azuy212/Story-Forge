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
import {
  appendRunLogEvent,
  sanitizeHeaders,
  withProviderLog,
} from "../utils/run-log.js";
import { parseServiceErrorEnvelope } from "./service-error.js";

const REQUEST_TIMEOUT_MS = 600_000;
const ASSETS_DIR = resolve("generated", "assets");

function mimeTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return "image/png";
}

/**
 * The image provider classifies its own failures (`type`) and is the only
 * component that may, but the envelope itself is read through the shared
 * parser so every provider client handles one shape.
 */
function parseProviderErrorBody(
  body: unknown,
  status: number,
): {
  type: ImageGenerationFailureType;
  message: string;
  rawMessage?: string;
} | null {
  const envelope = parseServiceErrorEnvelope(body);
  if (!envelope) return null;

  // Validate the type against the closed enum: a type the orchestrator does
  // not know must downgrade to `unknown` (fatal), never pass through as a
  // string that silently lands in the transient-retry branch.
  const parsed = ImageGenerationFailureTypeEnum.safeParse(envelope.code);
  const raw = envelope.details?.rawMessage;
  return {
    type: parsed.success ? parsed.data : "unknown",
    message:
      envelope.message || `Image-provider generation failed: HTTP ${status}`,
    rawMessage: typeof raw === "string" ? raw : undefined,
  };
}

export class ImageProviderAssetProvider implements AssetProvider {
  capabilities = { referenceImages: true, imageEditing: true };

  async generateImage(opts: GenerateImageOptions): Promise<AssetResult> {
    const filename =
      opts.filename ?? `scene-${String(opts.sceneId).padStart(3, "0")}.png`;
    const dir = opts.runId ? resolve(ASSETS_DIR, opts.runId) : ASSETS_DIR;
    const filePath = resolve(dir, filename);
    const startedAt = Date.now();
    const sink = opts.runLogSink ?? null;
    const requestEvent: Record<string, unknown> = {
      event: "provider_call",
      provider: "image_provider",
      operation: "image_generate",
      url: `${config.imageProviderUrl()}/generate`,
      method: "POST",
      headers: sanitizeHeaders({ "Content-Type": "application/json" }),
      runId: opts.runId,
      sceneId: opts.sceneId,
      mode: opts.mode ?? "text_to_image",
      referenceImageCount: opts.referenceImages?.length ?? 0,
      ...(opts.cacheNonce ? { cacheNonce: opts.cacheNonce } : {}),
      filename,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    let arrayBuffer: ArrayBuffer | undefined;
    let contentType: string | undefined;
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
            ...(opts.cacheNonce ? { cacheNonce: opts.cacheNonce } : {}),
          }
        : {
            prompt: opts.prompt,
            ...(opts.cacheNonce ? { cacheNonce: opts.cacheNonce } : {}),
          };
      requestEvent.requestBody = {
        prompt: opts.prompt,
        type: referenceImages ? "image" : undefined,
        mode: opts.mode ?? "text_to_image",
        referenceImageCount: referenceImages?.length ?? 0,
        ...(opts.cacheNonce ? { cacheNonce: opts.cacheNonce } : {}),
        ...(referenceImages
          ? {
              referenceImages: referenceImages.map((ref) => ({
                id: ref.id,
                filename: ref.filename,
                mime: ref.mime,
              })),
            }
          : {}),
      };
      requestEvent.requestBodyBytes = Buffer.byteLength(
        JSON.stringify(body),
        "utf-8",
      );

      response = await withProviderLog(sink, requestEvent, async () => {
        const r = await fetch(`${config.imageProviderUrl()}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        requestEvent.responseStatus = r.status;
        requestEvent.responseHeaders = sanitizeHeaders(
          Object.fromEntries(r.headers.entries()),
        );
        return r;
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
      requestEvent.responseBody = raw;
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

    contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      throw new PipelineError(
        `Unexpected image-provider content type: ${contentType}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

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

    requestEvent.responseBodyBytes = arrayBuffer.byteLength;
    requestEvent.responseContentType = contentType;

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, Buffer.from(arrayBuffer));
    } catch (err) {
      throw new PipelineError(
        `Failed to save image-provider result: ${(err as Error)?.message ?? String(err)}`,
        "ASSET_PROVIDER_ERROR",
      );
    }

    appendRunLogEvent(sink, {
      event: "asset_written",
      kind: "image_provider",
      path: filePath,
      byteSize: arrayBuffer.byteLength,
      provider: "image_provider",
      runId: opts.runId,
      sceneId: opts.sceneId,
      contentType,
      durationMs: Date.now() - startedAt,
    });

    return { url: filePath };
  }

  async generateVideo(_opts: GenerateVideoOptions): Promise<AssetResult> {
    throw new PipelineError(
      "Video generation not supported by image-provider adapter",
      "ASSET_PROVIDER_ERROR",
    );
  }
}
