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

const API_URL = "https://api.unsplash.com/search/photos";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [2_000, 5_000] as const;

interface UnsplashPhoto {
  id: string;
  urls: {
    raw: string;
    full: string;
    regular: string;
    small: string;
    thumb: string;
  };
  width: number;
  height: number;
  alt_description?: string;
  description?: string;
  user: {
    name: string;
    username: string;
  };
  links: {
    html: string;
  };
}

interface UnsplashResponse {
  results: UnsplashPhoto[];
  total: number;
}

export interface UnsplashProviderOptions {
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

export class UnsplashSourceAssetProvider implements SourceAssetProvider {
  readonly name = "unsplash";

  constructor(
    private readonly apiKey: string,
    private readonly options: UnsplashProviderOptions = {},
  ) {}

  async search(
    entity: SceneEntity,
    query: string,
    deadlineMs?: number,
    context?: SourceAssetSearchContext,
  ): Promise<SourceAsset[]> {
    if (!this.apiKey) return [];

    const params = new URLSearchParams({
      query,
      per_page: "12",
    });

    const url = `${API_URL}?${params.toString()}`;
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Client-ID ${this.apiKey}`,
    };
    const sink: RunLogSink | null = context?.sink ?? null;
    const event: Record<string, unknown> = {
      event: "provider_call",
      provider: "unsplash",
      operation: "photo_search",
      url,
      method: "GET",
      headers: sanitizeHeaders(requestHeaders),
      runId: context?.runId,
      entityName: entity.name,
      query,
    };
    const data = (await withProviderLog(sink, event, async () => {
      const response = await fetchWithRetry(
        url,
        { headers: requestHeaders },
        {
          timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
          deadlineMs,
          retryDelaysMs: this.options.retryDelaysMs ?? RETRY_DELAYS_MS,
        },
      );
      const body = await response.json();
      event.responseStatus = response.status;
      event.responseHeaders = sanitizeHeaders(
        Object.fromEntries(response.headers.entries()),
      );
      event.responseBody = body;
      const text = JSON.stringify(body);
      event.responseBodyBytes = Buffer.byteLength(text, "utf-8");
      return body;
    })) as UnsplashResponse;

    return data.results.map((photo): SourceAsset => ({
      id: `unsplash:${photo.id}`,
      entityId: entity.canonicalId ?? entity.name,
      url: photo.urls.full,
      source: "Unsplash",
      license: "Unsplash License",
      licenseUrl: "https://unsplash.com/license",
      attribution: photo.user.name,
      sourcePageUrl: photo.links.html,
      width: photo.width,
      height: photo.height,
      mimeType: "image/jpeg",
      title: photo.alt_description ?? photo.description ?? query,
    }));
  }
}
