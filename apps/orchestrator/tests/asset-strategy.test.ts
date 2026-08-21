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
import { FallbackSourceAssetSearcher } from "../src/providers/source-asset-search.js";
import { fetchWithRetry } from "../src/providers/source-asset-fetcher.js";
import type { SceneEntity, SourceAsset } from "../src/schemas/production.js";
import type { ProjectState, Scene } from "../src/types/index.js";
import type {
  SourceAssetSearcher,
  SourceAssetOutcome,
  SourceAssetProvider,
} from "../src/providers/source-asset-search.js";
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

const PERSON: SceneEntity = { type: "person", name: "Ada Lovelace" };

function stateWithScenes(scenes: Scene[]): ProjectState {
  return {
    project: { pillar: "History", topic: "People" },
    production: { scenes },
    execution: { version: "0.1.0" },
  } as ProjectState;
}

function makeNoMatchOutcome(queries: string[]): SourceAssetOutcome {
  return { status: "no_match", queries, totalDurationMs: 100 };
}

function makeFailureOutcome(
  provider: string,
  reason: string,
): SourceAssetOutcome {
  return { status: "provider_failure", provider, reason, totalDurationMs: 100 };
}

function makeAsset(
  id: string,
  overrides: Partial<SourceAsset> = {},
): SourceAsset {
  return {
    id,
    entityId: PERSON.name,
    url: `https://example.test/${id}.png`,
    source: "test",
    license: "CC BY",
    attribution: "tester",
    sourcePageUrl: `https://example.test/${id}`,
    width: 1200,
    height: 1600,
    mimeType: "image/png",
    title: "Ada Lovelace portrait",
    ...overrides,
  };
}

function makeProvider(
  name: string,
  impl: (
    entity: SceneEntity,
    query: string,
    deadlineMs?: number,
  ) => Promise<SourceAsset[]>,
): SourceAssetProvider {
  return { name, search: jest.fn(impl) };
}

function mockHangingFetch(): void {
  fetchSpy.mockImplementation((_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }
    });
  });
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
    const selected = selectBestSourceAsset(PERSON, [
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
    const selected = selectBestSourceAsset(PERSON, [
      {
        id: "unrelated",
        url: "https://example.test/unrelated.png",
        source: "test",
        title: "A landscape",
        width: 1200,
        height: 800,
      },
    ]);
    expect(selected).toBeUndefined();
  });

  it("accepts partial and sparse Wikimedia matches", () => {
    const selected = selectBestSourceAsset(PERSON, [
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
    ]);
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

    const [asset] = await new WikimediaSourceAssetProvider().search(PERSON);

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
    const provider = makeProvider("test", async () => [
      makeAsset("wikimedia:1"),
    ]);
    const searcher = new FallbackSourceAssetSearcher([provider], null, 60_000);

    const result = await assetStrategyNode(
      stateWithScenes([
        {
          sceneId: 1,
          generationPrompt: "Portrait",
          entities: [{ type: "person", name: "Ada Lovelace" }],
        },
      ]),
      { configurable: { sourceAssetSearcher: searcher } } as any,
    );

    const source = result.production?.sourceAssets?.[0];
    expect(result.production?.scenes[0].assetMode).toBe("source");
    expect(result.production?.scenes[0].sourceAssetIds).toEqual([
      "wikimedia:1",
    ]);
    expect(source).toMatchObject({
      source: "test",
      url: "https://example.test/wikimedia:1.png",
      license: "CC BY",
      attribution: "tester",
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
          "https://example.test/wikimedia:1 (CC BY)",
        ),
      }),
    );
  });

  it("falls back to generated when source search fails", async () => {
    const searcher: SourceAssetSearcher = {
      search: jest
        .fn<() => Promise<SourceAssetOutcome>>()
        .mockResolvedValue(
          makeFailureOutcome("wikimedia", "network:ENOTFOUND"),
        ),
    };

    const result = await assetStrategyNode(
      stateWithScenes([
        {
          sceneId: 1,
          entities: [{ type: "person", name: "Ada Lovelace" }],
        },
      ]),
      { configurable: { sourceAssetSearcher: searcher } } as any,
    );

    expect(result.production?.scenes[0].assetMode).toBe("generated");
    expect(result.production?.scenes[0].sourceAssetIds).toBeUndefined();
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.stringContaining('source lookup failed for "Ada Lovelace"'),
    );
  });

  it("falls back to generated when source search has no results", async () => {
    const searcher: SourceAssetSearcher = {
      search: jest
        .fn<() => Promise<SourceAssetOutcome>>()
        .mockResolvedValue(
          makeNoMatchOutcome(["Unknown Landmark", "Unknown Landmark landmark"]),
        ),
    };

    const result = await assetStrategyNode(
      stateWithScenes([
        {
          sceneId: 1,
          entities: [
            {
              type: "landmark",
              name: "Unknown Landmark",
              requiresSourceImage: true,
            },
          ],
        },
      ]),
      { configurable: { sourceAssetSearcher: searcher } } as any,
    );

    expect(result.production?.scenes[0].assetMode).toBe("generated");
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.stringContaining('no usable source asset for "Unknown Landmark"'),
    );
  });

  it("records provider failure warning with provider name and reason", async () => {
    const searcher: SourceAssetSearcher = {
      search: jest
        .fn<() => Promise<SourceAssetOutcome>>()
        .mockResolvedValue(makeFailureOutcome("unsplash", "http:429")),
    };

    const result = await assetStrategyNode(
      stateWithScenes([
        {
          sceneId: 1,
          entities: [{ type: "person", name: "Test Person" }],
        },
      ]),
      { configurable: { sourceAssetSearcher: searcher } } as any,
    );

    expect(result.diagnostics?.warnings).toContainEqual(
      expect.stringContaining(
        'source lookup failed for "Test Person" (unsplash: http:429)',
      ),
    );
  });

  it("records no_match warning with queries tried", async () => {
    const searcher: SourceAssetSearcher = {
      search: jest
        .fn<() => Promise<SourceAssetOutcome>>()
        .mockResolvedValue(
          makeNoMatchOutcome(["Test Entity", "Test Entity city"]),
        ),
    };

    const result = await assetStrategyNode(
      stateWithScenes([
        {
          sceneId: 1,
          entities: [
            { type: "place", name: "Test Entity", requiresSourceImage: true },
          ],
        },
      ]),
      { configurable: { sourceAssetSearcher: searcher } } as any,
    );

    expect(result.diagnostics?.warnings).toContainEqual(
      expect.stringContaining(
        'no usable source asset for "Test Entity" (queries: Test Entity, Test Entity city)',
      ),
    );
  });
});

describe("fallback searcher", () => {
  it("tries fallback provider when the first returns no results", async () => {
    const wikimedia = makeProvider("wikimedia", async () => []);
    const unsplash = makeProvider("unsplash", async () => [
      makeAsset("unsplash:1"),
    ]);
    const searcher = new FallbackSourceAssetSearcher(
      [wikimedia, unsplash],
      null,
      60_000,
    );

    const outcome = await searcher.search(PERSON);

    expect(unsplash.search).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("ok");
  });

  it("does not cache empty results", async () => {
    const cache = new FileSourceAssetCache(cacheDir);
    const wikimedia = makeProvider("wikimedia", async () => []);
    const searcher = new FallbackSourceAssetSearcher(
      [wikimedia],
      cache,
      60_000,
    );

    const outcome = await searcher.search(PERSON);

    expect(outcome.status).toBe("no_match");
    expect(await cache.get(PERSON, "Ada Lovelace")).toBeNull();
  });

  it("tries fallback provider when the first throws", async () => {
    const wikimedia = makeProvider("wikimedia", async () => {
      throw new Error("network:ENOTFOUND");
    });
    const unsplash = makeProvider("unsplash", async () => [
      makeAsset("unsplash:1"),
    ]);
    const searcher = new FallbackSourceAssetSearcher(
      [wikimedia, unsplash],
      null,
      60_000,
    );

    const outcome = await searcher.search(PERSON);

    expect(unsplash.search).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("ok");
  });

  it("does not cache provider failures", async () => {
    const cache = new FileSourceAssetCache(cacheDir);
    const wikimedia = makeProvider("wikimedia", async () => {
      throw new Error("network:ENOTFOUND");
    });
    const searcher = new FallbackSourceAssetSearcher(
      [wikimedia],
      cache,
      60_000,
    );

    await searcher.search(PERSON);

    expect(await cache.get(PERSON, "Ada Lovelace")).toBeNull();
  });

  it("reports provider_failure when all providers fail", async () => {
    const a = makeProvider("a", async () => {
      throw new Error("network:ECONNRESET");
    });
    const b = makeProvider("b", async () => {
      throw new Error("http:500");
    });
    const searcher = new FallbackSourceAssetSearcher([a, b], null, 60_000);

    const outcome = await searcher.search(PERSON);

    expect(outcome.status).toBe("provider_failure");
    if (outcome.status === "provider_failure") {
      expect(outcome.provider).toBe("multiple");
      expect(outcome.reason).toMatch(/http:500|ECONNRESET/);
    }
  });

  it("reports no_match when all providers return empty", async () => {
    const a = makeProvider("a", async () => []);
    const b = makeProvider("b", async () => []);
    const searcher = new FallbackSourceAssetSearcher([a, b], null, 60_000);

    const outcome = await searcher.search(PERSON);

    expect(outcome.status).toBe("no_match");
  });

  it("treats an existing empty cache entry as a miss", async () => {
    const cache = new FileSourceAssetCache(cacheDir);
    await cache.set(PERSON, "Ada Lovelace", []);
    const provider = makeProvider("test", async () => [
      makeAsset("wikimedia:1"),
    ]);
    const searcher = new FallbackSourceAssetSearcher([provider], cache, 60_000);

    const outcome = await searcher.search(PERSON);

    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("ok");
  });

  it("reuses a successful cached result without calling the provider", async () => {
    const cache = new FileSourceAssetCache(cacheDir);
    await cache.set(PERSON, "Ada Lovelace", [makeAsset("wikimedia:1")]);
    const provider = makeProvider("test", async () => [makeAsset("other:1")]);
    const searcher = new FallbackSourceAssetSearcher([provider], cache, 60_000);

    const outcome = await searcher.search(PERSON);

    expect(provider.search).not.toHaveBeenCalled();
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.asset.id).toBe("wikimedia:1");
    }
  });

  it("reports deadline_exceeded when materialization cannot finish in time", async () => {
    mockHangingFetch();
    const provider = makeProvider("test", async () => [
      makeAsset("wikimedia:1"),
    ]);
    const searcher = new FallbackSourceAssetSearcher([provider], null, 150);

    const started = Date.now();
    const outcome = await searcher.search(PERSON);

    expect(outcome.status).toBe("provider_failure");
    if (outcome.status === "provider_failure") {
      expect(outcome.reason).toBe("deadline_exceeded");
    }
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("cached provider does not cache empty results", async () => {
    const cache = new FileSourceAssetCache(cacheDir);
    const provider = makeProvider("test", async () => []);
    const cachedProvider = new CachedSourceAssetProvider(provider, cache);

    const assets = await cachedProvider.search(PERSON, "Ada Lovelace");

    expect(assets).toEqual([]);
    expect(await cache.get(PERSON, "Ada Lovelace")).toBeNull();
  });
});

describe("fetch with retry", () => {
  it("caps each attempt timeout by the remaining deadline", async () => {
    mockHangingFetch();
    const started = Date.now();

    await expect(
      fetchWithRetry(
        "https://example.test/1",
        {},
        { timeoutMs: 5_000, deadlineMs: Date.now() + 200, retryDelaysMs: [] },
      ),
    ).rejects.toThrow("timeout");

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not retry once the retry delay would exceed the deadline", async () => {
    fetchSpy.mockImplementation(
      async () => new Response("err", { status: 500 }),
    );
    const started = Date.now();

    await expect(
      fetchWithRetry(
        "https://example.test/1",
        {},
        {
          timeoutMs: 5_000,
          deadlineMs: Date.now() + 300,
          retryDelaysMs: [5_000],
        },
      ),
    ).rejects.toThrow("deadline_exceeded");

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("retries transient failures within the deadline", async () => {
    fetchSpy
      .mockImplementationOnce(async () => new Response("err", { status: 503 }))
      .mockImplementationOnce(async () => new Response("ok", { status: 200 }));

    const response = await fetchWithRetry(
      "https://example.test/1",
      {},
      {
        timeoutMs: 5_000,
        deadlineMs: Date.now() + 10_000,
        retryDelaysMs: [10],
      },
    );

    expect(response.status).toBe(200);
  });
});
