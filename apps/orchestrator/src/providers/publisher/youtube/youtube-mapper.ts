import type { PublishRequest } from "../publisher-provider.js";

/**
 * Deterministic label -> numeric categoryId mapping for YouTube's
 * videoCategories. The internal category label is platform-agnostic; each
 * platform mapper owns its own translation. Defaults to Education (27).
 */
const CATEGORY_ID_MAP: Record<string, string> = {
  Education: "27",
  "Science & Technology": "28",
  Entertainment: "24",
  "News & Politics": "25",
  "Howto & Style": "26",
};

export const DEFAULT_YOUTUBE_CATEGORY_ID = "27";

export function mapYouTubeCategoryId(category: string): string {
  const key = (category ?? "").trim();
  return CATEGORY_ID_MAP[key] ?? DEFAULT_YOUTUBE_CATEGORY_ID;
}

export function normalizeHashtags(hashtags: string[]): string[] {
  return hashtags
    .map((tag) => {
      const cleaned = tag.trim();
      if (!cleaned) return "";
      return cleaned.startsWith("#") ? cleaned : `#${cleaned}`;
    })
    .filter(Boolean);
}

export interface YouTubeInsertParams {
  part: string[];
  requestBody: {
    snippet: {
      title: string;
      description: string;
      tags: string[];
      categoryId: string;
      defaultLanguage?: string;
      defaultAudioLanguage?: string;
    };
    status: {
      privacyStatus: string;
      selfDeclaredMadeForKids: boolean;
      containsSyntheticMedia: boolean;
      publishAt?: string;
    };
  };
}

export function buildInsertParams(
  request: PublishRequest,
  options: { categoryId?: string } = {},
): YouTubeInsertParams {
  const tags = [...request.tags, ...normalizeHashtags(request.hashtags)];
  const categoryId =
    options.categoryId ?? mapYouTubeCategoryId(request.category);
  const language = request.language || undefined;

  return {
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: request.title,
        description: request.description,
        tags,
        categoryId,
        defaultLanguage: language,
        defaultAudioLanguage: language,
      },
      status: {
        privacyStatus: request.privacyStatus,
        selfDeclaredMadeForKids: request.madeForKids,
        containsSyntheticMedia: request.containsSyntheticMedia,
        // publishAt requires privacyStatus "private" and a never-published
        // video; PublishReady enforces the pair before reaching the provider.
        publishAt: request.publishAt,
      },
    },
  };
}

export function buildResultStatus(
  request: PublishRequest,
): "uploaded" | "published" | "scheduled" | "private" {
  if (request.publishAt) return "scheduled";
  if (request.privacyStatus === "private") return "private";
  return "published";
}
