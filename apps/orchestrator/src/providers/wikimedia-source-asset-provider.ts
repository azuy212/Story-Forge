import type { SceneEntity, SourceAsset } from "../schemas/production.js";
import type { SourceAssetProvider } from "./source-asset-provider.js";

const API_URL = "https://commons.wikimedia.org/w/api.php";
const COMMONS_URL = "https://commons.wikimedia.org";
const REQUEST_TIMEOUT_MS = 15_000;

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
  // `fullurl` comes from MediaWiki; fallback keeps provenance usable for
  // cached or partial API responses that omit it.
  return new URL(
    `/wiki/${encodeURIComponent(page.title).replace(/%3A/g, ":")}`,
    COMMONS_URL,
  ).toString();
}

export class WikimediaSourceAssetProvider implements SourceAssetProvider {
  async search(entity: SceneEntity): Promise<SourceAsset[]> {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: entity.name,
      gsrnamespace: "6",
      gsrwhat: "text",
      gsrlimit: "12",
      prop: "imageinfo|info",
      inprop: "url",
      iiprop: "url|size|mime|extmetadata",
      format: "json",
      origin: "*",
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Wikimedia search failed: HTTP ${response.status}`);
      }

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
    } finally {
      clearTimeout(timeout);
    }
  }
}
