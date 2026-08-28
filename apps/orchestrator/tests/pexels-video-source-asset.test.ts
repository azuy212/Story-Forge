import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import {
  PexelsSourceAssetProvider,
  PexelsVideoSourceAssetProvider,
} from "../src/providers/pexels-source-asset-provider.js";
import { materializeSourceAsset } from "../src/providers/source-asset-materializer.js";
import { createDefaultSourceAssetSearcher } from "../src/providers/source-asset-search.js";

const originalFetch = globalThis.fetch;

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Map() as unknown as Headers,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.reject(new Error("Unexpected arrayBuffer")),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("PexelsSourceAssetProvider (photos)", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("hits the photos search endpoint and emits image assets", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      makeJsonResponse(200, {
        page: 1,
        per_page: 12,
        total_results: 1,
        photos: [
          {
            id: 42,
            width: 4000,
            height: 6000,
            url: "https://www.pexels.com/photo/42/",
            photographer: "Jane",
            photographer_url: "https://www.pexels.com/@jane",
            alt: "a skyline",
            src: {
              original: "https://images.example/42.jpg",
              large2x: "https://images.example/42-large2x.jpg",
              large: "https://images.example/42-large.jpg",
              medium: "https://images.example/42-medium.jpg",
              small: "https://images.example/42-small.jpg",
              portrait: "https://images.example/42-portrait.jpg",
              landscape: "https://images.example/42-landscape.jpg",
              tiny: "https://images.example/42-tiny.jpg",
            },
          },
        ],
      }),
    );
    const provider = new PexelsSourceAssetProvider("test-key");
    const assets = await provider.search(
      { type: "place", name: "Boston" },
      "Boston",
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "pexels:42",
      mimeType: "image/jpeg",
      width: 4000,
      height: 6000,
    });
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/search");
    expect(url.searchParams.get("query")).toBe("Boston");
  });
});

describe("PexelsVideoSourceAssetProvider", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns [] when the entity has no target resolution", async () => {
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeJsonResponse(200, { videos: [] }));
    const provider = new PexelsVideoSourceAssetProvider("test-key");
    const assets = await provider.search(
      { type: "place", name: "Boston" },
      "Boston",
    );
    expect(assets).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns [] for square resolution (no orientation filter applies)", async () => {
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeJsonResponse(200, { videos: [] }));
    const provider = new PexelsVideoSourceAssetProvider("test-key");
    const assets = await provider.search(
      {
        type: "place",
        name: "X",
        resolution: { width: 1080, height: 1080 },
      },
      "X",
    );
    expect(assets).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hits the videos endpoint with orientation=portrait and matches exact resolution", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      makeJsonResponse(200, {
        page: 1,
        per_page: 20,
        total_results: 1,
        videos: [
          {
            id: 7,
            width: 1080,
            height: 1920,
            duration: 12,
            url: "https://www.pexels.com/video/7/",
            image: "https://images.example/7.jpg",
            user: { id: 1, name: "Videographer", url: "https://x" },
            video_files: [
              {
                id: 70,
                quality: "hd",
                file_type: "video/mp4",
                width: 1920,
                height: 1080,
                link: "https://videos.example/7-landscape.mp4",
              },
              {
                id: 71,
                quality: "hd",
                file_type: "video/mp4",
                width: 1080,
                height: 1920,
                link: "https://videos.example/7-portrait.mp4",
              },
            ],
          },
        ],
      }),
    );
    const provider = new PexelsVideoSourceAssetProvider("test-key");
    const assets = await provider.search(
      {
        type: "place",
        name: "Boston",
        resolution: { width: 1080, height: 1920 },
      },
      "Boston",
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "pexels-video:7:71",
      mimeType: "video/mp4",
      width: 1080,
      height: 1920,
      url: "https://videos.example/7-portrait.mp4",
      attribution: "Videographer",
    });
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/videos/search");
    expect(url.searchParams.get("query")).toBe("Boston");
    expect(url.searchParams.get("orientation")).toBe("portrait");
  });

  it("filters videos whose duration is below the floor", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      makeJsonResponse(200, {
        page: 1,
        per_page: 20,
        total_results: 1,
        videos: [
          {
            id: 7,
            width: 1080,
            height: 1920,
            duration: 2,
            url: "https://www.pexels.com/video/7/",
            image: "x",
            user: { id: 1, name: "V", url: "x" },
            video_files: [
              {
                id: 71,
                quality: "hd",
                file_type: "video/mp4",
                width: 1080,
                height: 1920,
                link: "https://videos.example/7.mp4",
              },
            ],
          },
        ],
      }),
    );
    const provider = new PexelsVideoSourceAssetProvider("test-key");
    const assets = await provider.search(
      {
        type: "place",
        name: "X",
        resolution: { width: 1080, height: 1920 },
        minimumDurationSec: 5,
      },
      "X",
    );
    expect(assets).toEqual([]);
  });
});

describe("source-asset-materializer (video acceptance)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts video/mp4 content-type and writes the file with the correct extension", async () => {
    const bytes = Buffer.from("fake-mp4-bytes");
    jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "video/mp4"]]) as unknown as Headers,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset)),
    } as unknown as Response);
    const materializer = await materializeSourceAsset(
      {
        id: "pexels-video:7:71",
        url: "https://videos.example/7.mp4",
        source: "Pexels",
        mimeType: "video/mp4",
      },
      "/tmp/materializer-video-test",
    );
    expect(materializer.localPath).toMatch(/\.mp4$/);
  });
});

describe("createDefaultSourceAssetSearcher (video provider wiring)", () => {
  const originalPexels = process.env.PEXELS_API_KEY;
  const originalVideo = process.env.ENABLE_VIDEO_ASSETS;

  afterEach(() => {
    if (originalPexels === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = originalPexels;
    if (originalVideo === undefined) delete process.env.ENABLE_VIDEO_ASSETS;
    else process.env.ENABLE_VIDEO_ASSETS = originalVideo;
  });

  it("does not push a video provider when ENABLE_VIDEO_ASSETS is off", async () => {
    process.env.PEXELS_API_KEY = "k";
    delete process.env.ENABLE_VIDEO_ASSETS;
    const searcher = createDefaultSourceAssetSearcher();
    const names = (
      searcher as unknown as { providers: { name: string }[] }
    ).providers.map((p) => p.name);
    expect(names).not.toContain("pexels-video");
    expect(names).toContain("pexels");
  });

  it("pushes the video provider when ENABLE_VIDEO_ASSETS=true and PEXELS_API_KEY is set", async () => {
    process.env.PEXELS_API_KEY = "k";
    process.env.ENABLE_VIDEO_ASSETS = "true";
    const searcher = createDefaultSourceAssetSearcher();
    const names = (
      searcher as unknown as { providers: { name: string }[] }
    ).providers.map((p) => p.name);
    expect(names).toContain("pexels");
    expect(names).toContain("pexels-video");
  });
});
