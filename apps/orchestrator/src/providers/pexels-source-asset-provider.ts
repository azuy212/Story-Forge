import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import type { SourceAssetProvider } from "./source-asset-provider.js";
import { fetchWithRetry } from "./source-asset-fetcher.js";

const API_URL = "https://api.pexels.com/v1/search";
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

interface PexelsResponse {
  total_results: number;
  page: number;
  per_page: number;
  photos: PexelsPhoto[];
  next_page?: string;
}

export interface PexelsProviderOptions {
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
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
  ): Promise<SourceAsset[]> {
    if (!this.apiKey) return [];

    const params = new URLSearchParams({
      query,
      per_page: "12",
    });

    const response = await fetchWithRetry(
      `${API_URL}?${params.toString()}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: this.apiKey,
        },
      },
      {
        timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        deadlineMs,
        retryDelaysMs: this.options.retryDelaysMs ?? RETRY_DELAYS_MS,
      },
    );

    const data = (await response.json()) as PexelsResponse;
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
