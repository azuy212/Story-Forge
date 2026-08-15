import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetStrategyNode,
  defaultAssetMode,
} from "../src/agents/asset-strategy.node.js";
import { publisherNode } from "../src/agents/publisher.node.js";
import {
  CachedSourceAssetProvider,
  FileSourceAssetCache,
} from "../src/providers/source-asset-cache.js";
import { selectBestSourceAsset } from "../src/providers/source-asset-selection.js";
import type { ProjectState, Scene, SourceAsset } from "../src/types/index.js";
import type { SourceAssetProvider } from "../src/providers/source-asset-provider.js";
import {
  WikimediaSourceAssetProvider,
  wikimediaPageUrl,
} from "../src/providers/wikimedia-source-asset-provider.js";

let cacheDir: string;
let fetchSpy: jest.Spied<typeof globalThis.fetch>;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "source-assets-"));
  process.env.SOURCE_ASSET_CACHE_DIR = cacheDir;
  fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(Buffer.from("source-image"), {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
  );
});

afterEach(async () => {
  fetchSpy.mockRestore();
  delete process.env.SOURCE_ASSET_CACHE_DIR;
  await rm(cacheDir, { recursive: true, force: true });
});

function stateWithScenes(scenes: Scene[]): ProjectState {
  return {
    project: { pillar: "History", topic: "People" },
    production: { scenes },
    execution: { version: "0.1.0" },
  } as ProjectState;
}

describe("asset strategy", () => {
  it("defaults scenes without entities to generated", () => {
    expect(defaultAssetMode({ sceneId: 1, visualDescription: "A storm" })).toBe(
      "generated",
    );
  });

  it("defaults real people to source mode", () => {
    expect(
      defaultAssetMode({
        sceneId: 1,
        entities: [{ type: "person", name: "Ada Lovelace" }],
      }),
    ).toBe("source");
  });

  it("preserves contextual mode for an identified entity", () => {
    expect(
      defaultAssetMode({
        sceneId: 1,
        assetMode: "source_composite",
        entities: [{ type: "person", name: "Ada Lovelace" }],
      }),
    ).toBe("source_composite");
  });

  it("selects best candidate deterministically", () => {
    const entity = { type: "person" as const, name: "Ada Lovelace" };
    const selected = selectBestSourceAsset(entity, [
      {
        id: "portrait",
        url: "https://example.test/portrait.png",
        source: "test",
        title: "Ada Lovelace portrait",
        sourcePageUrl: "https://example.test/wiki/Ada_Lovelace",
        width: 1200,
        height: 1600,
        license: "CC BY",
      },
      {
        id: "logo",
        url: "https://example.test/logo.png",
        source: "test",
        title: "Ada Lovelace logo",
        width: 2000,
        height: 2000,
      },
    ]);
    expect(selected?.id).toBe("portrait");
  });

  it("does not select unrelated source candidates", () => {
    const selected = selectBestSourceAsset(
      { type: "person", name: "Ada Lovelace" },
      [
        {
          id: "unrelated",
          url: "https://example.test/unrelated.png",
          source: "test",
          title: "A landscape",
          width: 1200,
          height: 800,
        },
      ],
    );
    expect(selected).toBeUndefined();
  });

  it("accepts partial and sparse Wikimedia matches", () => {
    const selected = selectBestSourceAsset(
      { type: "person", name: "Ada Lovelace" },
      [
        {
          id: "sparse",
          url: "https://upload.wikimedia.org/lovelace.png",
          source: "Wikimedia Commons",
          title: "Portrait of Ada",
          width: 1200,
          height: 1600,
        },
        {
          id: "partial",
          url: "https://upload.wikimedia.org/portrait.png",
          source: "Wikimedia Commons",
          title: "Portrait of Lovelace",
          width: 800,
          height: 600,
        },
      ],
    );
    expect(selected?.id).toBe("sparse");
  });

  it("maps Wikimedia source-page and license URLs", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          query: {
            pages: {
              "1": {
                pageid: 1,
                title: "File:Ada Lovelace.png",
                fullurl:
                  "https://commons.wikimedia.org/wiki/File:Ada%20Lovelace.png",
                imageinfo: [
                  {
                    url: "https://upload.wikimedia.org/ada.png",
                    width: 1200,
                    height: 1600,
                    mime: "image/png",
                    extmetadata: {
                      LicenseShortName: { value: "CC BY-SA 4.0" },
                      LicenseUrl: {
                        value:
                          "https://creativecommons.org/licenses/by-sa/4.0/",
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const [asset] = await new WikimediaSourceAssetProvider().search({
      type: "person",
      name: "Ada Lovelace",
    });

    expect(asset).toMatchObject({
      sourcePageUrl:
        "https://commons.wikimedia.org/wiki/File:Ada%20Lovelace.png",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    });
  });

  it("encodes fallback Wikimedia page URLs with special characters", () => {
    expect(
      wikimediaPageUrl({ title: "File:François & Ada Lovelace?.png" }),
    ).toBe(
      "https://commons.wikimedia.org/wiki/File:Fran%C3%A7ois%20%26%20Ada%20Lovelace%3F.png",
    );
    expect(
      wikimediaPageUrl({
        title: "File:ignored.png",
        fullurl: "https://commons.wikimedia.org/wiki/File:canonical.png",
      }),
    ).toBe("https://commons.wikimedia.org/wiki/File:canonical.png");
  });

  it("uses source result and persists provenance", async () => {
    const provider: SourceAssetProvider = {
      search: jest.fn<() => Promise<SourceAsset[]>>().mockResolvedValue([
        {
          id: "wikimedia:1",
          entityId: "Ada Lovelace",
          url: "https://commons.wikimedia.org/wiki/File:Ada.png",
          source: "Wikimedia Commons",
          license: "CC BY-SA 4.0",
          licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
          attribution: "Wikimedia contributor",
          sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Ada.png",
          width: 1200,
          height: 1600,
          mimeType: "image/png",
          title: "Ada Lovelace portrait",
        },
      ]),
    };

    const result = await assetStrategyNode(
      stateWithScenes([
        {
          sceneId: 1,
          generationPrompt: "Portrait",
          entities: [{ type: "person", name: "Ada Lovelace" }],
        },
      ]),
      { configurable: { sourceAssetProvider: provider } } as any,
    );

    const source = result.production?.sourceAssets?.[0];
    expect(result.production?.scenes[0].assetMode).toBe("source");
    expect(result.production?.scenes[0].sourceAssetIds).toEqual([
      "wikimedia:1",
    ]);
    expect(source).toMatchObject({
      source: "Wikimedia Commons",
      url: "https://commons.wikimedia.org/wiki/File:Ada.png",
      license: "CC BY-SA 4.0",
      attribution: "Wikimedia contributor",
    });
    expect(source?.localPath).toBeDefined();
    expect(await readFile(source!.localPath!)).toEqual(
      Buffer.from("source-image"),
    );

    const publish = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({
        platform: "youtube",
        platformVideoId: "abc",
        url: "https://example.test/published",
        status: "published",
        publishedAt: new Date().toISOString(),
      });
    await publisherNode(
      {
        project: { pillar: "History", topic: "People" },
        production: result.production,
        video: { videoUrl: "/tmp/video.mp4" },
        metadataOutput: {
          title: "Ada Lovelace",
          description: "Portrait",
          tags: [],
          hashtags: [],
          category: "Education",
          pinnedComment: "Source",
        },
        thumbnail: { imageUrl: "/tmp/thumbnail.png" },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: { publisherProvider: { publish } } } as any,
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining(
          "https://commons.wikimedia.org/wiki/File:Ada.png",
        ),
      }),
    );
  });

  it("falls back to generated when source search fails", async () => {
    const provider: SourceAssetProvider = {
      search: jest
        .fn<() => Promise<SourceAsset[]>>()
        .mockRejectedValue(new Error("API unavailable")),
    };

    const result = await assetStrategyNode(
      stateWithScenes([
        {
          sceneId: 1,
          entities: [{ type: "person", name: "Ada Lovelace" }],
        },
      ]),
      { configurable: { sourceAssetProvider: provider } } as any,
    );

    expect(result.production?.scenes[0].assetMode).toBe("generated");
    expect(result.production?.scenes[0].sourceAssetIds).toBeUndefined();
  });

  it("falls back to generated when source search has no results", async () => {
    const provider: SourceAssetProvider = {
      search: jest.fn<() => Promise<SourceAsset[]>>().mockResolvedValue([]),
    };

    const result = await assetStrategyNode(
      stateWithScenes([
        {
          sceneId: 1,
          entities: [{ type: "landmark", name: "Unknown Landmark" }],
        },
      ]),
      { configurable: { sourceAssetProvider: provider } } as any,
    );

    expect(result.production?.scenes[0].assetMode).toBe("generated");
  });

  it("reuses cached source search results", async () => {
    const entity = { type: "person" as const, name: "Ada Lovelace" };
    const cache = new FileSourceAssetCache(cacheDir);
    const provider: SourceAssetProvider = {
      search: jest.fn<() => Promise<SourceAsset[]>>().mockResolvedValue([
        {
          id: "wikimedia:1",
          url: "https://commons.wikimedia.org/wiki/File:Ada.png",
          source: "Wikimedia Commons",
        },
      ]),
    };
    const cachedProvider = new CachedSourceAssetProvider(provider, cache);

    await cachedProvider.search(entity);
    await cachedProvider.search(entity);
    expect(provider.search).toHaveBeenCalledTimes(1);
  });
});
