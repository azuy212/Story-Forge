import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_YOUTUBE_CATEGORY_ID,
  mapYouTubeCategoryId,
  normalizeHashtags,
  buildInsertParams,
  buildResultStatus,
} from "../src/providers/publisher/youtube/youtube-mapper.js";
import type { PublishRequest } from "../src/providers/publisher/publisher-provider.js";

function baseRequest(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    videoPath: "/tmp/video.mp4",
    title: "Title",
    description: "Description.",
    tags: ["geo"],
    hashtags: ["geographyfacts"],
    category: "Education",
    platform: "youtube",
    privacyStatus: "private",
    madeForKids: false,
    containsSyntheticMedia: true,
    language: "en",
    ...overrides,
  };
}

describe("mapYouTubeCategoryId", () => {
  it("maps known internal labels to numeric category ids", () => {
    expect(mapYouTubeCategoryId("Education")).toBe("27");
    expect(mapYouTubeCategoryId("Science & Technology")).toBe("28");
    expect(mapYouTubeCategoryId("Entertainment")).toBe("24");
    expect(mapYouTubeCategoryId("News & Politics")).toBe("25");
    expect(mapYouTubeCategoryId("Howto & Style")).toBe("26");
  });

  it("defaults unknown labels to Education", () => {
    expect(mapYouTubeCategoryId("Whatever")).toBe(DEFAULT_YOUTUBE_CATEGORY_ID);
    expect(mapYouTubeCategoryId("")).toBe(DEFAULT_YOUTUBE_CATEGORY_ID);
  });
});

describe("normalizeHashtags", () => {
  it("prefixes bare hashtags and leaves prefixed ones alone", () => {
    expect(normalizeHashtags(["geo", "#maps", ""])).toEqual(["#geo", "#maps"]);
  });
});

describe("buildInsertParams", () => {
  it("maps request fields into snippet and status", () => {
    const params = buildInsertParams(baseRequest());

    expect(params.part).toEqual(["snippet", "status"]);
    expect(params.requestBody.snippet.title).toBe("Title");
    expect(params.requestBody.snippet.description).toBe("Description.");
    expect(params.requestBody.snippet.tags).toEqual(["geo", "#geographyfacts"]);
    expect(params.requestBody.snippet.categoryId).toBe("27");
    expect(params.requestBody.snippet.defaultLanguage).toBe("en");
    expect(params.requestBody.status.privacyStatus).toBe("private");
    expect(params.requestBody.status.selfDeclaredMadeForKids).toBe(false);
    expect(params.requestBody.status.containsSyntheticMedia).toBe(true);
    expect(params.requestBody.status.publishAt).toBeUndefined();
  });

  it("honors an explicit categoryId override", () => {
    const params = buildInsertParams(baseRequest(), { categoryId: "28" });
    expect(params.requestBody.snippet.categoryId).toBe("28");
  });

  it("forwards publishAt and omits language when unset", () => {
    const params = buildInsertParams(
      baseRequest({
        publishAt: "2026-08-14T18:00:00.000Z",
        language: undefined,
      }),
    );
    expect(params.requestBody.status.publishAt).toBe(
      "2026-08-14T18:00:00.000Z",
    );
    expect(params.requestBody.snippet.defaultLanguage).toBeUndefined();
  });
});

describe("buildResultStatus", () => {
  it("maps publishAt to scheduled", () => {
    expect(
      buildResultStatus(baseRequest({ publishAt: "2026-08-14T18:00:00.000Z" })),
    ).toBe("scheduled");
  });

  it("maps private to private", () => {
    expect(buildResultStatus(baseRequest({ privacyStatus: "private" }))).toBe(
      "private",
    );
  });

  it("maps unlisted/public to published", () => {
    expect(buildResultStatus(baseRequest({ privacyStatus: "unlisted" }))).toBe(
      "published",
    );
    expect(buildResultStatus(baseRequest({ privacyStatus: "public" }))).toBe(
      "published",
    );
  });
});
