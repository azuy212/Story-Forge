import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YouTubeProvider } from "../src/providers/publisher/youtube/youtube-provider.js";
import { PublishError } from "../src/providers/publisher/youtube/youtube-errors.js";
import type { YouTubeApi } from "../src/providers/publisher/youtube/youtube-client.js";
import type { PublishRequest } from "../src/providers/publisher/publisher-provider.js";

type MockFn = jest.Mock<(...args: any[]) => Promise<any>>;

let dir: string;
let videoPath: string;
let thumbnailPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "youtube-provider-test-"));
  videoPath = join(dir, "video.mp4");
  thumbnailPath = join(dir, "thumb.png");
  await writeFile(videoPath, "fake-video-bytes");
  await writeFile(thumbnailPath, "fake-thumb-bytes");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface FakeApi {
  videos: { insert: MockFn };
  thumbnails: { set: MockFn };
  playlistItems: { insert: MockFn };
}

function makeApi(): FakeApi {
  return {
    videos: {
      insert: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValue({ data: { id: "abc123" } }),
    },
    thumbnails: {
      set: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValue({ data: {} }),
    },
    playlistItems: {
      insert: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValue({ data: {} }),
    },
  };
}

function makeProvider(
  api: FakeApi,
  overrides: { maxUploadRetries?: number; maxThumbnailRetries?: number } = {},
): YouTubeProvider {
  return new YouTubeProvider({
    api: api as unknown as YouTubeApi,
    ...overrides,
  });
}

function baseRequest(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    videoPath,
    title: "Title",
    description: "Description.",
    tags: ["geo"],
    hashtags: [],
    category: "Education",
    thumbnailPath,
    platform: "youtube",
    privacyStatus: "private",
    madeForKids: false,
    containsSyntheticMedia: true,
    ...overrides,
  };
}

describe("YouTubeProvider", () => {
  it("uploads, sets thumbnail, and reports the video id", async () => {
    const api = makeApi();
    const provider = makeProvider(api);
    const onUploaded = jest.fn<(...args: any[]) => Promise<void>>();
    const onThumbnailUploaded = jest.fn<(...args: any[]) => Promise<void>>();

    const result = await provider.publish(baseRequest(), {
      onUploaded,
      onThumbnailUploaded,
    });

    expect(api.videos.insert).toHaveBeenCalledTimes(1);
    const [params] = api.videos.insert.mock.calls[0];
    expect(params.uploadType).toBe("resumable");
    expect(params.requestBody.status.containsSyntheticMedia).toBe(true);
    expect(params.requestBody.status.selfDeclaredMadeForKids).toBe(false);
    expect(params.requestBody.snippet.categoryId).toBe("27");
    expect(onUploaded).toHaveBeenCalledWith("abc123");
    expect(api.thumbnails.set).toHaveBeenCalledTimes(1);
    expect(onThumbnailUploaded).toHaveBeenCalledWith("abc123");
    expect(result).toMatchObject({
      platform: "youtube",
      platformVideoId: "abc123",
      url: "https://youtu.be/abc123",
      status: "private",
    });
  });

  it("reports scheduled status when publishAt is set", async () => {
    const api = makeApi();
    const provider = makeProvider(api);
    const result = await provider.publish(
      baseRequest({ publishAt: "2026-08-14T18:00:00.000Z" }),
    );
    expect(result.status).toBe("scheduled");
    expect(api.videos.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          status: expect.objectContaining({
            publishAt: "2026-08-14T18:00:00.000Z",
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("adds videos to every requested playlist", async () => {
    const api = makeApi();
    const provider = makeProvider(api);
    await provider.publish(baseRequest({ playlistIds: ["PL1", "PL2"] }));

    expect(api.playlistItems.insert).toHaveBeenCalledTimes(2);
    expect(api.playlistItems.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          snippet: expect.objectContaining({
            playlistId: "PL1",
            resourceId: { kind: "youtube#video", videoId: "abc123" },
          }),
        }),
      }),
    );
  });

  it("retries a transient upload failure then succeeds", async () => {
    const api = makeApi();
    api.videos.insert
      .mockRejectedValueOnce({ code: 500, message: "backend hiccup" })
      .mockResolvedValueOnce({ data: { id: "abc123" } });
    const provider = makeProvider(api, { maxUploadRetries: 2 });

    const result = await provider.publish(baseRequest());

    expect(api.videos.insert).toHaveBeenCalledTimes(2);
    expect(result.platformVideoId).toBe("abc123");
  });

  it("gives up on permanent upload errors without firing onUploaded", async () => {
    const api = makeApi();
    api.videos.insert.mockRejectedValue({
      code: 400,
      errors: [{ reason: "invalidMetadata", message: "Bad metadata" }],
    });
    const provider = makeProvider(api);
    const onUploaded = jest.fn<(...args: any[]) => Promise<void>>();

    await expect(
      provider.publish(baseRequest(), { onUploaded }),
    ).rejects.toThrow(PublishError);
    expect(api.videos.insert).toHaveBeenCalledTimes(1);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("retries a brief thumbnail 404 (processing race) then succeeds", async () => {
    const api = makeApi();
    api.thumbnails.set
      .mockRejectedValueOnce({ code: 404, message: "not ready yet" })
      .mockResolvedValueOnce({ data: {} });
    const provider = makeProvider(api, { maxThumbnailRetries: 2 });
    const onThumbnailUploaded = jest.fn<(...args: any[]) => Promise<void>>();

    const result = await provider.publish(baseRequest(), {
      onThumbnailUploaded,
    });

    expect(api.thumbnails.set).toHaveBeenCalledTimes(2);
    expect(result.platformVideoId).toBe("abc123");
    expect(onThumbnailUploaded).toHaveBeenCalledWith("abc123");
  });

  it("treats a permanent thumbnail failure as failed finalization", async () => {
    const api = makeApi();
    api.thumbnails.set.mockRejectedValue({
      code: 400,
      message: "invalidImage",
    });
    const provider = makeProvider(api);

    await expect(provider.publish(baseRequest())).rejects.toThrow(PublishError);
    // Upload succeeded (onUploaded boundary) but finalization failed.
    expect(api.videos.insert).toHaveBeenCalledTimes(1);
  });

  it("resume skips upload and completed steps", async () => {
    const api = makeApi();
    const provider = makeProvider(api);

    const result = await provider.resume({
      ...baseRequest(),
      videoId: "abc123",
      thumbnailUploaded: true,
    });

    expect(api.videos.insert).not.toHaveBeenCalled();
    expect(api.thumbnails.set).not.toHaveBeenCalled();
    expect(result.platformVideoId).toBe("abc123");
  });

  it("resume re-attempts thumbnail when it was not yet uploaded", async () => {
    const api = makeApi();
    const provider = makeProvider(api);

    const result = await provider.resume({
      ...baseRequest(),
      videoId: "abc123",
      thumbnailUploaded: false,
    });

    expect(api.videos.insert).not.toHaveBeenCalled();
    expect(api.thumbnails.set).toHaveBeenCalledTimes(1);
    expect(result.platformVideoId).toBe("abc123");
  });

  it("rejects remote or missing video sources before uploading", async () => {
    const api = makeApi();
    const provider = makeProvider(api);

    await expect(
      provider.publish(baseRequest({ videoPath: "https://example.com/v.mp4" })),
    ).rejects.toThrow(PublishError);
    await expect(
      provider.publish(baseRequest({ videoPath: join(dir, "missing.mp4") })),
    ).rejects.toThrow(PublishError);
    expect(api.videos.insert).not.toHaveBeenCalled();
  });

  it("rejects remote thumbnail sources", async () => {
    const api = makeApi();
    const provider = makeProvider(api);

    await expect(
      provider.publish(
        baseRequest({ thumbnailPath: "https://example.com/t.png" }),
      ),
    ).rejects.toThrow(PublishError);
  });
});
