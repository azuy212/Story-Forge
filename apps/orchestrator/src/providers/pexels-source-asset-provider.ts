import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import type {
  SourceAssetProvider,
  SourceAssetSearchContext,
} from "./source-asset-provider.js";
import { fetchWithRetry } from "./source-asset-fetcher.js";
import {
  sanitizeHeaders,
  withProviderLog,
  type RunLogSink,
} from "../utils/run-log.js";

const PHOTO_API_URL = "https://api.pexels.com/v1/search";
const VIDEO_API_URL = "https://api.pexels.com/v1/videos/search";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [2_000, 5_000] as const;

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt: string;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
}

interface PexelsPhotoResponse {
  total_results: number;
  page: number;
  per_page: number;
  photos: PexelsPhoto[];
  next_page?: string;
}

interface PexelsVideoFile {
  id: number;
  quality: string;
  file_type: string;
  width: number;
  height: number;
  link: string;
}

interface PexelsVideoUser {
  id: number;
  name: string;
  url: string;
}

interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user: PexelsVideoUser;
  video_files: PexelsVideoFile[];
}

interface PexelsVideoResponse {
  total_results: number;
  page: number;
  per_page: number;
  videos: PexelsVideo[];
  next_page?: string;
}

export interface PexelsProviderOptions {
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

interface PexelsRequestOptions {
  timeoutMs: number;
  deadlineMs?: number;
  retryDelaysMs: readonly number[];
}

function orientationFor(
  width: number,
  height: number,
): "portrait" | "landscape" | "square" {
  if (height > width) return "portrait";
  if (width > height) return "landscape";
  return "square";
}

class PexelsClient {
  constructor(
    private readonly apiKey: string,
    private readonly options: PexelsRequestOptions,
    private readonly sink: RunLogSink | null,
    private readonly runId: string | undefined,
    private readonly entity: SceneEntity,
    private readonly query: string,
    private readonly operation: "photo_search" | "video_search",
  ) {}

  async getJson<T>(url: string): Promise<T> {
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.apiKey,
    };
    const event: Record<string, unknown> = {
      event: "provider_call",
      provider: "pexels",
      operation: this.operation,
      url,
      method: "GET",
      headers: sanitizeHeaders(requestHeaders),
      runId: this.runId,
      entityName: this.entity.name,
      query: this.query,
    };
    return withProviderLog(this.sink, event, async () => {
      const response = await fetchWithRetry(
        url,
        {
          headers: requestHeaders,
        },
        this.options,
      );
      const body = await response.json();
      event.responseStatus = response.status;
      event.responseHeaders = sanitizeHeaders(
        Object.fromEntries(response.headers.entries()),
      );
      event.responseBody = body;
      const text = JSON.stringify(body);
      event.responseBodyBytes = Buffer.byteLength(text, "utf-8");
      return body as T;
    });
  }
}

export class PexelsSourceAssetProvider implements SourceAssetProvider {
  readonly name = "pexels";

  constructor(
    private readonly apiKey: string,
    private readonly options: PexelsProviderOptions = {},
  ) {}

  async search(
    entity: SceneEntity,
    query: string,
    deadlineMs?: number,
    context?: SourceAssetSearchContext,
  ): Promise<SourceAsset[]> {
    if (!this.apiKey) return [];

    const client = new PexelsClient(
      this.apiKey,
      {
        timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        deadlineMs,
        retryDelaysMs: this.options.retryDelaysMs ?? RETRY_DELAYS_MS,
      },
      context?.sink ?? null,
      context?.runId,
      entity,
      query,
      "photo_search",
    );
    const params = new URLSearchParams({ query, per_page: "12" });
    const data = await client.getJson<PexelsPhotoResponse>(
      `${PHOTO_API_URL}?${params.toString()}`,
    );
    return data.photos.map((photo): SourceAsset => ({
      id: `pexels:${photo.id}`,
      entityId: entity.canonicalId ?? entity.name,
      url: photo.src.large2x,
      source: "Pexels",
      license: "Pexels License",
      licenseUrl: "https://www.pexels.com/license/",
      attribution: photo.photographer,
      sourcePageUrl: photo.url,
      width: photo.width,
      height: photo.height,
      mimeType: "image/jpeg",
      title: photo.alt ?? query,
    }));
  }
}

export class PexelsVideoSourceAssetProvider implements SourceAssetProvider {
  readonly name = "pexels-video";

  constructor(
    private readonly apiKey: string,
    private readonly options: PexelsProviderOptions = {},
  ) {}

  async search(
    entity: SceneEntity,
    query: string,
    deadlineMs?: number,
    context?: SourceAssetSearchContext,
  ): Promise<SourceAsset[]> {
    if (!this.apiKey) return [];
    if (!entity.resolution) return [];

    const orientation = orientationFor(
      entity.resolution.width,
      entity.resolution.height,
    );
    if (orientation === "square") return [];

    const client = new PexelsClient(
      this.apiKey,
      {
        timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        deadlineMs,
        retryDelaysMs: this.options.retryDelaysMs ?? RETRY_DELAYS_MS,
      },
      context?.sink ?? null,
      context?.runId,
      entity,
      query,
      "video_search",
    );
    const params = new URLSearchParams({
      query,
      per_page: "20",
      orientation,
    });
    const data = await client.getJson<PexelsVideoResponse>(
      `${VIDEO_API_URL}?${params.toString()}`,
    );

    const targetW = entity.resolution.width;
    const targetH = entity.resolution.height;
    const targetRatio = targetW / targetH;
    const aspectTolerance = 0.15; // ponytail: ±15% aspect; tighten once we have a
    // quality signal from real runs.
    const minDuration = entity.minimumDurationSec ?? 0;
    const results: SourceAsset[] = [];

    for (const video of data.videos) {
      if (minDuration > 0 && video.duration < minDuration) continue;
      for (const file of video.video_files) {
        if (file.width <= 0 || file.height <= 0) continue;
        const ratio = file.width / file.height;
        if (Math.abs(ratio - targetRatio) / targetRatio > aspectTolerance) {
          continue;
        }
        results.push({
          id: `pexels-video:${video.id}:${file.id}`,
          entityId: entity.canonicalId ?? entity.name,
          url: file.link,
          source: "Pexels",
          license: "Pexels License",
          licenseUrl: "https://www.pexels.com/license/",
          attribution: video.user?.name,
          sourcePageUrl: video.url,
          width: file.width,
          height: file.height,
          mimeType: "video/mp4",
          title: query,
        });
        break;
      }
    }
    return results;
  }
}
