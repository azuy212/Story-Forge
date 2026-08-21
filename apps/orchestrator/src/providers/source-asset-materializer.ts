import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { hashObject } from "../artifacts/hash.js";
import type { SourceAsset } from "../schemas/production.js";

const REQUEST_TIMEOUT_MS = 30_000;

function extension(asset: SourceAsset, contentType: string): string {
  const fromMime = contentType.split("/")[1]?.split(";")[0];
  if (fromMime && /^[a-z0-9]+$/i.test(fromMime))
    return fromMime === "jpeg" ? "jpg" : fromMime;
  const fromUrl = extname(new URL(asset.url).pathname).replace(/^\./, "");
  return /^[a-z0-9]+$/i.test(fromUrl) ? fromUrl : "img";
}

export async function materializeSourceAsset(
  asset: SourceAsset,
  directory: string,
  deadlineMs?: number,
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
  try {
    const response = await fetch(asset.url, { signal: controller.signal });
    if (!response.ok)
      throw new Error(`Source image download failed: HTTP ${response.status}`);
    const contentType =
      response.headers.get("content-type") ?? asset.mimeType ?? "";
    if (!contentType.startsWith("image/") || contentType.includes("svg")) {
      throw new Error(`Source image is not an image: ${contentType}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("Source image response was empty");

    const filePath = join(
      mediaDir,
      `${hashObject(asset.id)}.${extension(asset, contentType)}`,
    );
    await writeFile(filePath, bytes, { flag: "wx" }).catch(
      async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      },
    );
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
