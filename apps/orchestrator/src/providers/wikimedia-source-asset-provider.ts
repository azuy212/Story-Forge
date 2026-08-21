import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import type { SourceAssetProvider } from "./source-asset-provider.js";
import { fetchWithRetry } from "./source-asset-fetcher.js";

const API_URL = "https://commons.wikimedia.org/w/api.php";
const COMMONS_URL = "https://commons.wikimedia.org";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [2_000, 5_000] as const;

interface MetadataValue {
  value?: string;
}

interface WikimediaImageInfo {
  url?: string;
  width?: number;
  height?: number;
  mime?: string;
  extmetadata?: Record<string, MetadataValue>;
}

interface WikimediaPage {
  pageid?: number;
  title?: string;
  fullurl?: string;
  imageinfo?: WikimediaImageInfo[];
}

interface WikimediaResponse {
  query?: { pages?: Record<string, WikimediaPage> };
}

function metadataValue(
  metadata: Record<string, MetadataValue> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key]?.value?.trim();
  return value || undefined;
}

export function wikimediaPageUrl(
  page: Pick<WikimediaPage, "title" | "fullurl">,
): string | undefined {
  if (page.fullurl) return page.fullurl;
  if (!page.title) return undefined;
  return new URL(
    `/wiki/${encodeURIComponent(page.title).replace(/%3A/g, ":")}`,
    COMMONS_URL,
  ).toString();
}

export interface WikimediaProviderOptions {
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

export class WikimediaSourceAssetProvider implements SourceAssetProvider {
  readonly name = "wikimedia";

  constructor(private readonly options: WikimediaProviderOptions = {}) {}

  async search(
    entity: SceneEntity,
    query: string = entity.name,
    deadlineMs?: number,
  ): Promise<SourceAsset[]> {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrnamespace: "6",
      gsrwhat: "text",
      gsrlimit: "12",
      prop: "imageinfo|info",
      inprop: "url",
      iiprop: "url|size|mime|extmetadata",
      format: "json",
      origin: "*",
    });

    const response = await fetchWithRetry(
      `${API_URL}?${params.toString()}`,
      {
        headers: { Accept: "application/json" },
      },
      {
        timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        deadlineMs,
        retryDelaysMs: this.options.retryDelaysMs ?? RETRY_DELAYS_MS,
      },
    );

    const data = (await response.json()) as WikimediaResponse;
    return Object.values(data.query?.pages ?? []).flatMap((page) => {
      const info = page.imageinfo?.[0];
      if (
        !info?.url ||
        !info.mime?.startsWith("image/") ||
        !Number.isInteger(info.width) ||
        !Number.isInteger(info.height)
      ) {
        return [];
      }

      const metadata = info.extmetadata;
      return [
        {
          id: `wikimedia:${page.pageid ?? page.title ?? info.url}`,
          entityId: entity.canonicalId ?? entity.name,
          url: info.url,
          source: "Wikimedia Commons",
          license:
            metadataValue(metadata, "LicenseShortName") ??
            metadataValue(metadata, "License"),
          licenseUrl: metadataValue(metadata, "LicenseUrl"),
          attribution:
            metadataValue(metadata, "Credit") ??
            metadataValue(metadata, "Artist"),
          sourcePageUrl: wikimediaPageUrl(page),
          width: info.width,
          height: info.height,
          mimeType: info.mime,
          title: page.title,
        },
      ];
    });
  }
}
