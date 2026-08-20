import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { publisherNode } from "../src/agents/publisher.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockPublish = jest.fn<(...args: any[]) => Promise<any>>();

function makeMockProvider() {
  return { publish: mockPublish };
}

function runNode(state?: Partial<ProjectState>) {
  const provider = makeMockProvider();
  const promise = publisherNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      video: {
        videoUrl: "https://example.com/video.mp4",
        durationMs: 3000,
        resolution: "1080x1920",
        composedAt: "2026-01-01T00:00:00.000Z",
      },
      metadataOutput: {
        title: "Test Title",
        description: "Test description.",
        tags: ["geo"],
        hashtags: ["#geo"],
        category: "Education",
        pinnedComment: "Comment",
      },
      thumbnail: {
        imageUrl: "https://placeholder.local/thumbnail.png",
        thumbnailPrompt: "High contrast aerial view",
        thumbnailText: "Doesn't Exist?",
        textPosition: "bottom-third",
        colorScheme: "cold blue",
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      branding: { channel: "TestChannel", creator: "", cta: "" },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: { publisherProvider: provider } } as any,
  );
  return { promise, provider };
}

function buildPublishResponse(platform: string) {
  return {
    platform,
    platformVideoId: "video-001",
    url: `https://placeholder.local/${platform}/video-001`,
    status: "published",
    publishedAt: new Date().toISOString(),
  };
}

describe("publisherNode", () => {
  beforeEach(() => {
    mockPublish.mockReset();
  });

  it("successful publish to single platform", async () => {
    mockPublish.mockResolvedValueOnce(buildPublishResponse("youtube"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.publishing?.results).toHaveLength(1);
    expect(result.publishing?.results![0].platform).toBe("youtube");
    expect(result.publishing?.results![0].status).toBe("published");
    expect(result.publishing?.results![0].url).toBe(
      "https://placeholder.local/youtube/video-001",
    );
    expect(result.publishing?.results![0].platformVideoId).toBe("video-001");
    expect(result.publishing?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.execution?.currentNode).toBe("Publisher");
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "youtube",
        videoPath: "https://example.com/video.mp4",
        title: "Test Title",
        madeForKids: false,
        containsSyntheticMedia: true,
        privacyStatus: "private",
      }),
    );
  });

  it("successful publish to multiple platforms", async () => {
    mockPublish
      .mockResolvedValueOnce(buildPublishResponse("youtube"))
      .mockResolvedValueOnce(buildPublishResponse("tiktok"));

    const { promise } = runNode({
      branding: {
        channel: "C",
        creator: "",
        cta: "",
        platforms: ["youtube", "tiktok"],
      },
    } as any);
    const result = await promise;

    expect(result.publishing?.results).toHaveLength(2);
    expect(result.publishing?.results![0].platform).toBe("youtube");
    expect(result.publishing?.results![1].platform).toBe("tiktok");
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it("includes source credits in published description", async () => {
    mockPublish.mockResolvedValueOnce(buildPublishResponse("youtube"));

    const { promise } = runNode({
      production: {
        scenes: [{ sceneId: 1, sourceAssetIds: ["source-1"] }],
        sourceAssets: [
          {
            id: "source-1",
            url: "https://upload.wikimedia.org/source.png",
            source: "Wikimedia Commons",
            sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Source.png",
            license: "CC BY-SA 4.0",
            licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
            title: "Source portrait",
          },
        ],
      } as any,
    });
    await promise;

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Source credits:"),
      }),
    );
  });

  it("missing videoUrl silently no-ops", async () => {
    const { promise } = runNode({ video: {} } as any);
    const result = await promise;

    expect(result.diagnostics).toEqual({});
    expect(result.diagnostics?.errors).toBeUndefined();
    expect(result.publishing).toEqual({});
    expect(result.execution).toEqual({ currentNode: "Publisher" });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("missing metadata title returns error", async () => {
    const { promise } = runNode({
      metadataOutput: { description: "D" },
    } as any);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "metadata title is missing",
    );
    expect(result.publishing?.results).toEqual([]);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("partial failure is fail-closed (not cached, error surfaced)", async () => {
    mockPublish
      .mockResolvedValueOnce(buildPublishResponse("youtube"))
      .mockRejectedValueOnce(new Error("Rate limited"))
      .mockResolvedValueOnce(buildPublishResponse("instagram"));

    const { promise } = runNode({
      branding: {
        channel: "C",
        creator: "",
        cta: "",
        platforms: ["youtube", "tiktok", "instagram"],
      },
    } as any);
    const result = await promise;

    expect(result.publishing?.results ?? []).toHaveLength(0);
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Rate limited");
    expect(result.diagnostics?.errors![0]).toContain("tiktok");
    expect(result.diagnostics?.errors![0]).toContain(
      "Succeeded: youtube, instagram",
    );
    expect(mockPublish).toHaveBeenCalledTimes(3);
  });

  it("stub default provider works", async () => {
    // configurable with no publisherProvider => uses StubPublisherProvider
    const result = await publisherNode(
      {
        project: { pillar: "P", topic: "T" },
        video: { videoUrl: "https://example.com/video.mp4" },
        metadataOutput: { title: "T" },
        branding: { channel: "C", creator: "", cta: "" },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: {} } as any,
    );

    expect(result.publishing?.results).toHaveLength(1);
    expect(result.publishing?.results![0].platform).toBe("youtube");
    expect(result.publishing?.results![0].status).toBe("published");
  });

  it("sets execution.currentNode", async () => {
    mockPublish.mockResolvedValueOnce(buildPublishResponse("youtube"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.execution?.currentNode).toBe("Publisher");
  });

  it("default platform is youtube when branding.platforms not set", async () => {
    mockPublish.mockResolvedValueOnce(buildPublishResponse("youtube"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.publishing?.results).toHaveLength(1);
    expect(result.publishing?.results![0].platform).toBe("youtube");
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "youtube" }),
    );
  });

  it("sheets sync failure does not fail the publish", async () => {
    mockPublish.mockResolvedValueOnce(buildPublishResponse("youtube"));
    const sheetsApi = {
      get: jest
        .fn<() => Promise<any>>()
        .mockRejectedValueOnce(new Error("Sheets 500")),
    };

    const previous = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID = "spreadsheet-test";
    try {
      const result = await publisherNode(
        {
          project: { pillar: "Geography", topic: "Test", projectId: "v-123" },
          video: {
            videoUrl: "https://example.com/video.mp4",
            durationMs: 3000,
            resolution: "1080x1920",
            composedAt: "2026-01-01T00:00:00.000Z",
          },
          metadataOutput: {
            title: "Test Title",
            description: "Test description.",
            tags: ["geo"],
            hashtags: ["#geo"],
            category: "Education",
            pinnedComment: "Comment",
          },
          thumbnail: {
            imageUrl: "https://placeholder.local/thumbnail.png",
          },
          branding: { channel: "TestChannel", creator: "", cta: "" },
          execution: { version: "0.1.0" },
        } as ProjectState,
        {
          configurable: { publisherProvider: makeMockProvider(), sheetsApi },
        } as any,
      );

      expect(result.publishing?.results).toHaveLength(1);
      expect(result.publishing?.results![0].status).toBe("published");
      expect(result.diagnostics?.errors).toBeUndefined();
      expect(sheetsApi.get).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      } else {
        process.env.GOOGLE_SHEETS_SPREADSHEET_ID = previous;
      }
    }
  });
});
