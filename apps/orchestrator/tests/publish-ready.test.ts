import { describe, it, expect, afterEach } from "@jest/globals";
import {
  publishReadyNode,
  PUBLISH_READY,
} from "../src/agents/publish-ready.node.js";
import type { ProjectState } from "../src/types/index.js";

const originalEnv: Record<string, string | undefined> = {};

function rememberEnv(...names: string[]): void {
  for (const name of names) {
    originalEnv[name] = process.env[name];
  }
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function completeState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    project: { pillar: "Geography", topic: "Test" },
    video: {
      videoUrl: "https://placeholder.local/final.mp4",
      durationMs: 3000,
      resolution: "1080x1920",
    },
    metadataOutput: {
      title: "Test Title",
      description: "Test description.",
      tags: ["geo"],
      hashtags: [],
      category: "Education",
      pinnedComment: "C",
    },
    thumbnail: {
      imageUrl: "https://placeholder.local/thumb.png",
    },
    branding: { channel: "C", creator: "", cta: "" },
    execution: { version: "0.1.0" },
    ...overrides,
  } as ProjectState;
}

describe("publishReadyNode", () => {
  it("is a silent no-op while the package is incomplete", async () => {
    const result = await publishReadyNode(completeState({ video: {} }));

    expect(result.publishReady).toEqual({});
    expect(result.diagnostics).toEqual({});
    expect(result.execution?.currentNode).toBe(PUBLISH_READY);
  });

  it("approves a complete package with placeholder URLs and publishing off", async () => {
    const result = await publishReadyNode(completeState());

    expect(result.publishReady).toEqual({ status: "ready", issues: [] });
    expect(result.diagnostics).toEqual({});
  });

  it("blocks when the local video file does not exist", async () => {
    const result = await publishReadyNode(
      completeState({ video: { videoUrl: "/nonexistent/video.mp4" } }),
    );

    expect(result.publishReady?.status).toBe("blocked");
    expect(result.diagnostics?.errors?.[0]).toContain(
      "Final video file missing",
    );
  });

  it("blocks when the local thumbnail file does not exist", async () => {
    const result = await publishReadyNode(
      completeState({ thumbnail: { imageUrl: "/nonexistent/thumb.png" } }),
    );

    expect(result.publishReady?.status).toBe("blocked");
    expect(result.diagnostics?.errors?.[0]).toContain("Thumbnail file missing");
  });

  it("blocks on an over-long title", async () => {
    const result = await publishReadyNode(
      completeState({
        metadataOutput: {
          title: "x".repeat(101),
          description: "D",
          tags: ["geo"],
          hashtags: [],
          category: "Education",
          pinnedComment: "C",
        },
      }),
    );

    expect(result.publishReady?.status).toBe("blocked");
    expect(result.diagnostics?.errors?.[0]).toContain("exceeds 100 characters");
  });

  it("blocks on an over-long description", async () => {
    const result = await publishReadyNode(
      completeState({
        metadataOutput: {
          title: "T",
          description: "d".repeat(5001),
          tags: ["geo"],
          hashtags: [],
          category: "Education",
          pinnedComment: "C",
        },
      }),
    );

    expect(result.publishReady?.status).toBe("blocked");
    expect(result.diagnostics?.errors?.[0]).toContain(
      "exceeds 5000 characters",
    );
  });

  it("blocks when publishAt is set without private privacyStatus", async () => {
    rememberEnv("YOUTUBE_PUBLISH_AT", "YOUTUBE_PRIVACY_STATUS");
    process.env.YOUTUBE_PUBLISH_AT = "2026-08-14T18:00:00.000Z";
    process.env.YOUTUBE_PRIVACY_STATUS = "unlisted";

    const result = await publishReadyNode(completeState());

    expect(result.publishReady?.status).toBe("blocked");
    expect(result.diagnostics?.errors?.[0]).toContain(
      'publishAt requires privacyStatus "private"',
    );
  });

  it("approves publishAt when privacy is private", async () => {
    rememberEnv("YOUTUBE_PUBLISH_AT");
    process.env.YOUTUBE_PUBLISH_AT = "2026-08-14T18:00:00.000Z";

    const result = await publishReadyNode(completeState());

    expect(result.publishReady?.status).toBe("ready");
  });

  it("blocks when real publishing is enabled but credentials are missing", async () => {
    rememberEnv(
      "USE_REAL_PROVIDERS",
      "YOUTUBE_PUBLISHING_ENABLED",
      "YOUTUBE_CLIENT_ID",
      "YOUTUBE_CLIENT_SECRET",
      "YOUTUBE_REFRESH_TOKEN",
    );
    process.env.USE_REAL_PROVIDERS = "true";
    process.env.YOUTUBE_PUBLISHING_ENABLED = "true";
    delete process.env.YOUTUBE_CLIENT_ID;
    delete process.env.YOUTUBE_CLIENT_SECRET;
    delete process.env.YOUTUBE_REFRESH_TOKEN;

    const result = await publishReadyNode(completeState());

    expect(result.publishReady?.status).toBe("blocked");
    expect(result.diagnostics?.errors?.[0]).toContain(
      "YouTube credentials missing",
    );
  });

  it("approves when credentials are present", async () => {
    rememberEnv(
      "USE_REAL_PROVIDERS",
      "YOUTUBE_PUBLISHING_ENABLED",
      "YOUTUBE_CLIENT_ID",
      "YOUTUBE_CLIENT_SECRET",
      "YOUTUBE_REFRESH_TOKEN",
    );
    process.env.USE_REAL_PROVIDERS = "true";
    process.env.YOUTUBE_PUBLISHING_ENABLED = "true";
    process.env.YOUTUBE_CLIENT_ID = "id";
    process.env.YOUTUBE_CLIENT_SECRET = "secret";
    process.env.YOUTUBE_REFRESH_TOKEN = "token";

    const result = await publishReadyNode(completeState());

    expect(result.publishReady?.status).toBe("ready");
  });
});
