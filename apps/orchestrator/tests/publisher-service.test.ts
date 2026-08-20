import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  jest,
} from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishForPlatforms } from "../src/providers/publisher/publisher-service.js";
import { FilesystemArtifactStore } from "../src/artifacts/fs/fs-artifact-store.js";
import type {
  PublisherProvider,
  PublishRequest,
} from "../src/providers/publisher/publisher-provider.js";
import type { ProjectState } from "../src/types/index.js";
import type { PublicationArtifact } from "../src/schemas/publication.js";

let dir: string;
let store: FilesystemArtifactStore;
let runId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "publisher-service-test-"));
  process.env.ARTIFACT_STORE_DIR = dir;
  store = new FilesystemArtifactStore();
});

afterAll(async () => {
  delete process.env.ARTIFACT_STORE_DIR;
  await rm(dir, { recursive: true, force: true });
});

function baseRequest(): Omit<PublishRequest, "platform"> {
  return {
    videoPath: "/tmp/video.mp4",
    title: "Title",
    description: "Description.",
    tags: ["geo"],
    hashtags: [],
    category: "Education",
    privacyStatus: "private",
    madeForKids: false,
    containsSyntheticMedia: true,
  };
}

function makeResult(platform = "youtube", videoId = "abc123") {
  return {
    platform,
    platformVideoId: videoId,
    url: `https://youtu.be/${videoId}`,
    status: "published" as const,
    publishedAt: new Date().toISOString(),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    configurable: { runId, artifactStore: store, ...overrides },
  } as never;
}

const state: ProjectState = {} as ProjectState;

function seed(artifact: PublicationArtifact) {
  return store.save(
    runId,
    "publication",
    { [artifact.publicationId]: artifact },
    { inputHash: artifact.publicationId, runId },
    "complete",
  );
}

function now() {
  return new Date().toISOString();
}

describe("publishForPlatforms", () => {
  beforeEach(() => {
    // Isolate each test with a unique run key so publication artifacts never
    // leak across cases.
    runId = `test-run-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    store = new FilesystemArtifactStore();
  });

  it("publishes directly when no artifact store / run id is present", async () => {
    const publish = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue(makeResult());
    const provider: PublisherProvider = { publish: publish as never };

    const execution = await publishForPlatforms({
      config: { configurable: {} } as never,
      state: {} as ProjectState,
      platforms: ["youtube"],
      request: baseRequest(),
      injectedProvider: provider,
    });

    expect(execution.errors).toHaveLength(0);
    expect(execution.results).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "youtube" }),
    );
  });

  it("persists the videoId via onUploaded before finalizing", async () => {
    const publish = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockImplementation(async (_request: unknown, options: unknown) => {
        const opts = options as { onUploaded?: (id: string) => Promise<void> };
        await opts.onUploaded?.("vid1");
        return makeResult("youtube", "vid1");
      });
    const provider: PublisherProvider = { publish: publish as never };

    const execution = await publishForPlatforms({
      config: makeConfig(),
      state,
      platforms: ["youtube"],
      request: baseRequest(),
      injectedProvider: provider,
    });

    expect(execution.results[0]?.platformVideoId).toBe("vid1");

    const record = await store.latest<Record<string, PublicationArtifact>>(
      runId,
      "publication",
    );
    const artifact = record?.data?.[`${runId}:youtube`];
    expect(artifact?.status).toBe("published");
    expect(artifact?.videoId).toBe("vid1");
  });

  it("resumes an interrupted publication via provider.resume", async () => {
    await seed({
      publicationId: `${runId}:youtube`,
      platform: "youtube",
      status: "failed",
      videoId: "abc123",
      error: { code: "thumbnail_failed", message: "boom", retryable: false },
      createdAt: now(),
      updatedAt: now(),
    });

    const resume = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue(makeResult("youtube", "abc123"));
    const publish = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue(makeResult("youtube", "abc123"));
    const provider: PublisherProvider = {
      publish: publish as never,
      resume: resume as never,
    };

    const execution = await publishForPlatforms({
      config: makeConfig(),
      state,
      platforms: ["youtube"],
      request: baseRequest(),
      injectedProvider: provider,
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: "abc123",
      }),
      expect.any(Object),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(execution.results[0]?.platformVideoId).toBe("abc123");

    const record = await store.latest<Record<string, PublicationArtifact>>(
      runId,
      "publication",
    );
    expect(record?.data?.[`${runId}:youtube`]?.status).toBe("published");
  });

  it("short-circuits a previously published publication without calling the provider", async () => {
    await seed({
      publicationId: `${runId}:youtube`,
      platform: "youtube",
      status: "published",
      videoId: "abc123",
      createdAt: now(),
      updatedAt: now(),
    });

    const publish = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue(makeResult());
    const provider: PublisherProvider = { publish: publish as never };

    const execution = await publishForPlatforms({
      config: makeConfig(),
      state,
      platforms: ["youtube"],
      request: baseRequest(),
      injectedProvider: provider,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(execution.results[0]?.platformVideoId).toBe("abc123");
    expect(execution.results[0]?.url).toBe("https://youtu.be/abc123");
  });

  it("marks a failure with the already-uploaded videoId for resume", async () => {
    const publish = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockImplementation(async (_request: unknown, options: unknown) => {
        const opts = options as { onUploaded?: (id: string) => Promise<void> };
        await opts.onUploaded?.("vid1");
        throw new Error("thumbnail upload failed");
      });
    const provider: PublisherProvider = { publish: publish as never };

    const execution = await publishForPlatforms({
      config: makeConfig(),
      state,
      platforms: ["youtube"],
      request: baseRequest(),
      injectedProvider: provider,
    });

    expect(execution.results).toHaveLength(0);
    expect(execution.errors[0]).toContain("thumbnail upload failed");

    const record = await store.latest<Record<string, PublicationArtifact>>(
      runId,
      "publication",
    );
    const artifact = record?.data?.[`${runId}:youtube`];
    expect(artifact?.status).toBe("failed");
    expect(artifact?.videoId).toBe("vid1");
    expect(artifact?.error).toBeDefined();
  });

  it("publishes to multiple platforms and surfaces partial failures", async () => {
    const publish = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockImplementation((request: unknown) => {
        const req = request as PublishRequest;
        if (req.platform === "tiktok")
          return Promise.reject(new Error("Rate limited"));
        return Promise.resolve(makeResult(req.platform));
      });
    const provider: PublisherProvider = { publish: publish as never };

    const execution = await publishForPlatforms({
      config: makeConfig(),
      state,
      platforms: ["youtube", "tiktok"],
      request: baseRequest(),
      injectedProvider: provider,
    });

    expect(execution.results).toHaveLength(1);
    expect(execution.results[0]?.platform).toBe("youtube");
    expect(execution.errors[0]).toContain("tiktok publish failed");
    expect(execution.errors[0]).toContain("Rate limited");
  });
});
