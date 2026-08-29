import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { hashObject } from "../artifacts/hash.js";
import type { SourceAsset } from "../schemas/production.js";
import {
  appendRunLogEvent,
  sanitizeHeaders,
  withProviderLog,
  type RunLogSink,
} from "../utils/run-log.js";

const REQUEST_TIMEOUT_MS = 30_000;

function extension(asset: SourceAsset, contentType: string): string {
  const fromMime = contentType.split("/")[1]?.split(";")[0];
  if (fromMime && /^[a-z0-9]+$/i.test(fromMime))
    return fromMime === "jpeg" ? "jpg" : fromMime;
  const fromUrl = extname(new URL(asset.url).pathname).replace(/^\./, "");
  return /^[a-z0-9]+$/i.test(fromUrl) ? fromUrl : "img";
}

export interface MaterializeContext {
  sink?: RunLogSink | null;
  runId?: string;
  entityName?: string;
}

export async function materializeSourceAsset(
  asset: SourceAsset,
  directory: string,
  deadlineMs?: number,
  context: MaterializeContext = {},
): Promise<SourceAsset> {
  if (asset.localPath) {
    const exists = await stat(asset.localPath)
      .then(() => true)
      .catch(() => false);
    if (exists) return asset;
  }

  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new Error("materialize_deadline_exceeded");
  }

  const mediaDir = join(directory, "media");
  await mkdir(mediaDir, { recursive: true });

  const remainingTimeout =
    deadlineMs !== undefined
      ? Math.min(REQUEST_TIMEOUT_MS, deadlineMs - Date.now())
      : REQUEST_TIMEOUT_MS;

  if (remainingTimeout <= 0) {
    throw new Error("materialize_deadline_exceeded");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingTimeout);
  const startedAt = Date.now();
  const sink = context.sink ?? null;
  const event: Record<string, unknown> = {
    event: "provider_call",
    provider: "source_asset_download",
    operation: asset.mimeType?.startsWith("video/")
      ? "video_download"
      : "image_download",
    url: asset.url,
    method: "GET",
    headers: {},
    runId: context.runId,
    entityName: context.entityName,
    assetId: asset.id,
  };
  let filePath: string | undefined;
  let byteSize: number | undefined;
  try {
    const buffer = await withProviderLog(sink, event, async () => {
      const response = await fetch(asset.url, {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          `Source image download failed: HTTP ${response.status}`,
        );
      const contentType =
        response.headers.get("content-type") ?? asset.mimeType ?? "";
      const isImage =
        contentType.startsWith("image/") && !contentType.includes("svg");
      const isVideo =
        contentType.startsWith("video/mp4") ||
        contentType.startsWith("video/webm");
      if (!isImage && !isVideo) {
        throw new Error(
          `Source asset is not an image or video: ${contentType}`,
        );
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length === 0) throw new Error("Source asset response was empty");
      event.responseStatus = response.status;
      event.responseHeaders = sanitizeHeaders(
        Object.fromEntries(response.headers.entries()),
      );
      event.responseBodyBytes = buf.length;
      return buf;
    });

    const contentType =
      (event.responseHeaders as Record<string, string> | undefined)?.[
        "content-type"
      ] ??
      asset.mimeType ??
      "";
    filePath = join(
      mediaDir,
      `${hashObject(asset.id)}.${extension(asset, contentType)}`,
    );
    await writeFile(filePath, buffer, { flag: "wx" }).catch(
      async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      },
    );
    byteSize = buffer.length;
    appendRunLogEvent(sink, {
      event: "asset_written",
      kind: contentType.startsWith("video/") ? "source_video" : "source_image",
      path: filePath,
      byteSize,
      provider: asset.source,
      runId: context.runId,
      assetId: asset.id,
      entityName: context.entityName,
      durationMs: Date.now() - startedAt,
    });
    return {
      ...asset,
      localPath: filePath,
      mimeType: contentType.split(";")[0],
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "AbortError"
    ) {
      throw new Error("materialize_deadline_exceeded", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
