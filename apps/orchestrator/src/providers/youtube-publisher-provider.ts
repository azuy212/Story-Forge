import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  PublisherProvider,
  PublishOptions,
  PublishResult,
} from "./publisher-provider.js";
import type { AccessTokenProvider } from "./google-oauth.js";
import { GoogleOAuthRefreshTokenProvider } from "./google-oauth.js";
import { config } from "../utils/config.js";

type FetchLike = typeof fetch;
type PrivacyStatus = "private" | "unlisted" | "public";
type UploadReceipt = {
  videoId: string;
  fileSize: number;
  modifiedAtMs: number;
};

export type YouTubePublisherOptions = {
  fetchImpl?: FetchLike;
  tokenProvider?: AccessTokenProvider;
  privacyStatus?: PrivacyStatus;
  defaultCategoryId?: string;
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
};

const CATEGORY_IDS: Record<string, string> = {
  "film & animation": "1",
  "autos & vehicles": "2",
  music: "10",
  "pets & animals": "15",
  sports: "17",
  "travel & events": "19",
  gaming: "20",
  "people & blogs": "22",
  comedy: "23",
  entertainment: "24",
  "news & politics": "25",
  "howto & style": "26",
  education: "27",
  "science & technology": "28",
  "nonprofits & activism": "29",
};

function localPath(value: string): string {
  if (value.startsWith("file://")) return fileURLToPath(value);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new Error(
      `YouTube upload requires a local video file, received: ${value}`,
    );
  }
  return path.resolve(value);
}

function videoMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    default:
      return "video/mp4";
  }
}

function imageMimeType(value: string): string {
  switch (path.extname(new URL(value, "file:///").pathname).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function categoryId(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return CATEGORY_IDS[trimmed.toLocaleLowerCase()] ?? fallback;
}

function descriptionWithHashtags(
  description: string,
  hashtags: string[],
): string {
  const normalized = hashtags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
  const missing = normalized.filter((tag) => !description.includes(tag));
  return missing.length > 0
    ? `${description.trim()}\n\n${missing.join(" ")}`.trim()
    : description;
}

export class YouTubePublisherProvider implements PublisherProvider {
  private readonly fetchImpl: FetchLike;
  private readonly tokenProvider: AccessTokenProvider;
  private readonly privacyStatus: PrivacyStatus;
  private readonly defaultCategoryId: string;
  private readonly madeForKids?: boolean;
  private readonly containsSyntheticMedia?: boolean;

  constructor(options: YouTubePublisherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenProvider =
      options.tokenProvider ??
      new GoogleOAuthRefreshTokenProvider(this.fetchImpl);
    this.privacyStatus = options.privacyStatus ?? config.youtubePrivacyStatus();
    this.defaultCategoryId =
      options.defaultCategoryId ?? config.youtubeCategoryId();
    this.madeForKids = options.madeForKids ?? config.youtubeMadeForKids();
    this.containsSyntheticMedia =
      options.containsSyntheticMedia ?? config.youtubeContainsSyntheticMedia();
  }

  async publish(opts: PublishOptions): Promise<PublishResult> {
    if (opts.platform.toLocaleLowerCase() !== "youtube") {
      throw new Error(
        `YouTubePublisherProvider cannot publish to ${opts.platform}`,
      );
    }

    const filePath = localPath(opts.videoUrl);
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile() || fileInfo.size <= 0) {
      throw new Error(`YouTube upload video is missing or empty: ${filePath}`);
    }

    const token = await this.tokenProvider.getAccessToken();
    const receiptPath = path.join(
      path.dirname(filePath),
      ".youtube-upload.json",
    );
    const existing = await this.readReceipt(receiptPath);
    let videoId =
      existing &&
      existing.fileSize === fileInfo.size &&
      existing.modifiedAtMs === fileInfo.mtimeMs
        ? existing.videoId
        : undefined;

    if (!videoId) {
      videoId = await this.uploadVideo(token, filePath, fileInfo.size, opts);
      await this.writeReceipt(receiptPath, {
        videoId,
        fileSize: fileInfo.size,
        modifiedAtMs: fileInfo.mtimeMs,
      });
    }

    if (opts.thumbnailUrl) {
      await this.uploadThumbnail(token, videoId, opts.thumbnailUrl);
    }

    return {
      platform: "youtube",
      publishUrl: `https://studio.youtube.com/video/${videoId}/edit`,
      status: this.privacyStatus,
      publishedAt: new Date().toISOString(),
    };
  }

  private async uploadVideo(
    token: string,
    filePath: string,
    fileSize: number,
    opts: PublishOptions,
  ): Promise<string> {
    const mimeType = videoMimeType(filePath);
    const status: Record<string, unknown> = {
      privacyStatus: this.privacyStatus,
    };
    if (opts.scheduledAt) status.publishAt = opts.scheduledAt;
    if (this.madeForKids !== undefined) {
      status.selfDeclaredMadeForKids = this.madeForKids;
    }
    if (this.containsSyntheticMedia !== undefined) {
      status.containsSyntheticMedia = this.containsSyntheticMedia;
    }

    const metadata = {
      snippet: {
        title: opts.title,
        description: descriptionWithHashtags(opts.description, opts.hashtags),
        tags: opts.tags,
        categoryId: categoryId(opts.category, this.defaultCategoryId),
      },
      status,
    };

    const start = await this.fetchImpl(
      "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(fileSize),
          "X-Upload-Content-Type": mimeType,
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!start.ok) {
      throw new Error(
        `YouTube upload initialization failed (${start.status}): ${await start.text()}`,
      );
    }
    const uploadUrl = start.headers.get("location");
    if (!uploadUrl) {
      throw new Error(
        "YouTube upload initialization did not return a location.",
      );
    }

    const request = {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
        "Content-Length": String(fileSize),
      },
      body: createReadStream(filePath) as unknown as BodyInit,
      duplex: "half",
    } satisfies RequestInit & { duplex: "half" };
    const upload = await this.fetchImpl(uploadUrl, request);
    const body = (await upload.json()) as { id?: string; error?: unknown };
    if (!upload.ok || !body.id) {
      throw new Error(
        `YouTube video upload failed (${upload.status}): ${JSON.stringify(body.error ?? body)}`,
      );
    }
    return body.id;
  }

  private async uploadThumbnail(
    token: string,
    videoId: string,
    thumbnailUrl: string,
  ): Promise<void> {
    let bytes: Uint8Array;
    if (/^https?:\/\//i.test(thumbnailUrl)) {
      const response = await this.fetchImpl(thumbnailUrl);
      if (!response.ok) {
        throw new Error(
          `Thumbnail download failed (${response.status}): ${response.statusText}`,
        );
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      bytes = await readFile(localPath(thumbnailUrl));
    }

    const response = await this.fetchImpl(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": imageMimeType(thumbnailUrl),
          "Content-Length": String(bytes.byteLength),
        },
        body: bytes as BodyInit,
      },
    );
    if (!response.ok) {
      throw new Error(
        `YouTube thumbnail upload failed (${response.status}): ${await response.text()}`,
      );
    }
  }

  private async readReceipt(
    receiptPath: string,
  ): Promise<UploadReceipt | null> {
    try {
      const value = JSON.parse(
        await readFile(receiptPath, "utf8"),
      ) as UploadReceipt;
      return value.videoId ? value : null;
    } catch {
      return null;
    }
  }

  private async writeReceipt(
    receiptPath: string,
    receipt: UploadReceipt,
  ): Promise<void> {
    const temporaryPath = `${receiptPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(receipt, null, 2), "utf8");
    await rename(temporaryPath, receiptPath);
  }
}
