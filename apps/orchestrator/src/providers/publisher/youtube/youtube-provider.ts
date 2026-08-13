import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  PublisherProvider,
  PublishCallOptions,
  PublishRequest,
  PublishResult,
  ResumePublishRequest,
} from "../publisher-provider.js";
import type { YouTubeApi } from "./youtube-client.js";
import { createYouTubeApi } from "./youtube-client.js";
import { StubPublisherProvider } from "../stub-publisher-provider.js";
import { config } from "../../../utils/config.js";
import { PublishError, mapYouTubeError } from "./youtube-errors.js";
import { buildInsertParams, buildResultStatus } from "./youtube-mapper.js";

export interface YouTubeProviderOptions {
  api: YouTubeApi;
  /** Explicit numeric category override; falls back to label mapping. */
  categoryId?: string;
  maxUploadRetries?: number;
  maxThumbnailRetries?: number;
}

const DEFAULT_MAX_UPLOAD_RETRIES = 3;
const DEFAULT_MAX_THUMBNAIL_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const THUMBNAIL_MIME = "image/png";
const VIDEO_MIME = "video/mp4";

function isHttpUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a step whose failures are classified by `mapYouTubeError`. Each
 * attempt is isolated: streams are recreated by the caller so a consumed
 * body cannot poison a retry.
 */
async function retryStep<T>(
  attempts: number,
  run: (attempt: number) => Promise<T>,
): Promise<T> {
  let last: PublishError | null = null;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (err) {
      const info =
        err instanceof PublishError ? err.info : mapYouTubeError(err);
      if (!info.retryable || attempt >= attempts) {
        throw new PublishError(info);
      }
      last = new PublishError(info);
      await sleep(backoffMs(attempt));
    }
  }
  throw (
    last ??
    new PublishError({
      code: "unknown",
      message: "step failed",
      retryable: false,
    })
  );
}

export class YouTubeProvider implements PublisherProvider {
  private readonly api: YouTubeApi;
  private readonly categoryId?: string;
  private readonly maxUploadRetries: number;
  private readonly maxThumbnailRetries: number;

  constructor(options: YouTubeProviderOptions) {
    this.api = options.api;
    this.categoryId = options.categoryId;
    this.maxUploadRetries =
      options.maxUploadRetries ?? DEFAULT_MAX_UPLOAD_RETRIES;
    this.maxThumbnailRetries =
      options.maxThumbnailRetries ?? DEFAULT_MAX_THUMBNAIL_RETRIES;
  }

  async publish(
    request: PublishRequest,
    options?: PublishCallOptions,
  ): Promise<PublishResult> {
    await this.validateVideoFile(request);

    const videoId = await this.uploadVideo(request, options);
    await this.finalize(request, { ...request, videoId }, options);

    return this.buildResult(request, videoId);
  }

  async resume(
    request: ResumePublishRequest,
    options?: PublishCallOptions,
  ): Promise<PublishResult> {
    await this.validateVideoFile(request);
    await this.finalize(request, request, options);
    return this.buildResult(request, request.videoId);
  }

  private buildResult(request: PublishRequest, videoId: string): PublishResult {
    return {
      platform: request.platform,
      platformVideoId: videoId,
      url: `https://youtu.be/${videoId}`,
      status: buildResultStatus(request),
      publishedAt: new Date().toISOString(),
    };
  }

  /**
   * Resumable videos.insert. googleapis owns the resumable session within a
   * single attempt; transient failures recreate the stream and start a fresh
   * session. `onUploaded` fires immediately on the confirmed videoId — the
   * idempotency boundary before any thumbnail/playlist work.
   */
  private async uploadVideo(
    request: PublishRequest,
    options?: PublishCallOptions,
  ): Promise<string> {
    return retryStep(this.maxUploadRetries, async () => {
      const media = {
        body: createReadStream(request.videoPath),
        mimeType: VIDEO_MIME,
      };
      const response = await this.api.videos.insert(
        {
          part: buildInsertParams(request, { categoryId: this.categoryId })
            .part,
          requestBody: buildInsertParams(request, {
            categoryId: this.categoryId,
          }).requestBody,
          media,
          uploadType: "resumable",
        },
        {
          onUploadProgress: (progress) => {
            // Resumable session progress; intentionally best-effort.
            void progress;
          },
        },
      );

      const videoId = response.data?.id;
      if (!videoId) {
        throw new PublishError({
          code: "missing_video_id",
          message: "videos.insert succeeded without a video id",
          retryable: false,
        });
      }

      await options?.onUploaded?.(videoId);
      return videoId;
    });
  }

  /**
   * Thumbnail + playlist + metadata finalization. Shared by fresh uploads and
   * resumed publications, which skip steps the persisted artifact already
   * records as done.
   */
  private async finalize(
    request: PublishRequest,
    current: { videoId: string; thumbnailUploaded?: boolean },
    options?: PublishCallOptions,
  ): Promise<void> {
    if (request.thumbnailPath && !current.thumbnailUploaded) {
      await this.uploadThumbnail(request, current.videoId, options);
    }

    for (const playlistId of request.playlistIds ?? []) {
      await retryStep(this.maxThumbnailRetries, async () => {
        await this.api.playlistItems.insert({
          part: ["snippet"],
          requestBody: {
            snippet: {
              playlistId,
              resourceId: { kind: "youtube#video", videoId: current.videoId },
            },
          },
        });
      });
    }
  }

  private async uploadThumbnail(
    request: PublishRequest,
    videoId: string,
    options?: PublishCallOptions,
  ): Promise<void> {
    const thumbnailPath = request.thumbnailPath;
    if (!thumbnailPath) return;
    if (isHttpUrl(thumbnailPath)) {
      throw new PublishError({
        code: "invalid_thumbnail",
        message: `Remote thumbnail sources are not supported: ${thumbnailPath}`,
        retryable: false,
      });
    }

    await retryStep(this.maxThumbnailRetries, async () => {
      // A newly created video may not be ready for thumbnails.set yet;
      // 404s are retried briefly, permanent image/auth errors are not.
      try {
        await this.api.thumbnails.set({
          videoId,
          media: {
            body: createReadStream(thumbnailPath),
            mimeType: THUMBNAIL_MIME,
          },
          uploadType: "media",
        });
      } catch (err) {
        const info = mapYouTubeError(err, { retryOnNotFound: true });
        throw new PublishError(info);
      }
    });

    await options?.onThumbnailUploaded?.(videoId);
  }

  private async validateVideoFile(request: PublishRequest): Promise<void> {
    const path = request.videoPath;
    if (!path) {
      throw new PublishError({
        code: "missing_video",
        message: "publish request has no videoPath",
        retryable: false,
      });
    }
    if (isHttpUrl(path)) {
      throw new PublishError({
        code: "invalid_video",
        message: `Remote video sources are not supported for upload: ${path}`,
        retryable: false,
      });
    }
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size === 0) {
        throw new PublishError({
          code: "invalid_video",
          message: `Video file is not a non-empty file: ${path}`,
          retryable: false,
        });
      }
    } catch (err) {
      if (err instanceof PublishError) throw err;
      throw new PublishError({
        code: "invalid_video",
        message: `Video file not found or unreadable: ${path}`,
        retryable: false,
      });
    }
  }
}

/** Registry factory: real provider only when publishing is opted in. */
export function createYouTubeProvider(): PublisherProvider {
  if (!config.useRealProviders() || !config.youtubePublishingEnabled()) {
    return new StubPublisherProvider();
  }

  const clientId = config.youtubeClientId();
  const clientSecret = config.youtubeClientSecret();
  const refreshToken = config.youtubeRefreshToken();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "YouTube publishing requires YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, " +
        "and YOUTUBE_REFRESH_TOKEN (and YOUTUBE_PUBLISHING_ENABLED=true). " +
        "See scripts/oauth-youtube.mjs to obtain a refresh token.",
    );
  }

  const api = createYouTubeApi({ clientId, clientSecret, refreshToken });
  return new YouTubeProvider({ api, categoryId: config.youtubeCategoryId() });
}
