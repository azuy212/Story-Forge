import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { assetGeneratorNode } from "../src/agents/asset-generator.node.js";
import type { ProjectState, Scene } from "../src/types/index.js";
import type { AssetProvider } from "../src/providers/asset-provider.js";

const mockGenerateImage = jest.fn<(...args: any[]) => Promise<any>>();
const mockGenerateVideo = jest.fn<(...args: any[]) => Promise<any>>();

const mockProvider: AssetProvider = {
  generateImage: mockGenerateImage,
  generateVideo: mockGenerateVideo,
};

beforeEach(() => {
  mockGenerateImage.mockReset();
  mockGenerateVideo.mockReset();
  mockGenerateImage.mockResolvedValue({ url: "https://stub/img.png" });
  mockGenerateVideo.mockResolvedValue({ url: "https://stub/vid.mp4" });
});

function runNode(state: Partial<ProjectState>) {
  return assetGeneratorNode(
    {
      project: { pillar: "History", topic: "Test" },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: { assetProvider: mockProvider } } as any,
  );
}

describe("assetGeneratorNode — stock video source", () => {
  it("uses a source video as-is for assetType=video + assetMode=source with a source match", async () => {
    const scene: Scene = {
      sceneId: 1,
      generationPrompt: "Aerial drone footage of a coast.",
      assetType: "video",
      assetMode: "source",
      filename: "scene-001.mp4",
      sourceAssetIds: ["v1"],
    };
    const result = await runNode({
      production: {
        scenes: [scene],
        sourceAssets: [
          {
            id: "v1",
            url: "https://videos.pexels.com/abc.mp4",
            source: "Pexels",
            mimeType: "video/mp4",
            localPath: "/tmp/abc.mp4",
          },
        ],
      },
    });
    const out = result.production?.scenes?.[0];
    expect(out?.assetKind).toBe("source-video");
    expect(out?.assetUrl).toBe("/tmp/abc.mp4");
    expect(out?.generationStatus).toBe("complete");
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockGenerateVideo).not.toHaveBeenCalled();
  });
});

describe("assetGeneratorNode — video fallback to image", () => {
  it("falls back to image when assetType=video, assetMode=source, no source match", async () => {
    const scene: Scene = {
      sceneId: 1,
      generationPrompt: "Aerial drone footage of a coast.",
      assetType: "video",
      assetMode: "source",
      filename: "scene-001.mp4",
      // No sourceAssetIds: the visual planner emitted no source-searchable
      // entities for this scene.
    };
    const result = await runNode({ production: { scenes: [scene] } });
    const out = result.production?.scenes?.[0];
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    expect(mockGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Aerial drone footage of a coast.",
        sceneId: 1,
        filename: "scene-001.mp4",
      }),
    );
    expect(mockGenerateVideo).not.toHaveBeenCalled();
    expect(out?.assetKind).toBe("generated-image");
    expect(out?.assetType).toBe("image");
    expect(out?.assetUrl).toBe("https://stub/img.png");
    expect(out?.generationStatus).toBe("complete");
    expect(out?.fallbackReason).toBe("no stock video match");
    // The fallback surfaces in the run's diagnostics so the user sees it.
    expect(result.diagnostics?.warnings?.[0]).toContain("no stock video match");
  });

  it("falls back to image when assetType=video, assetMode=generated", async () => {
    const scene: Scene = {
      sceneId: 1,
      generationPrompt: "Aerial drone footage of a coast.",
      assetType: "video",
      filename: "scene-001.mp4",
    };
    const result = await runNode({ production: { scenes: [scene] } });
    const out = result.production?.scenes?.[0];
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    expect(mockGenerateVideo).not.toHaveBeenCalled();
    expect(out?.assetKind).toBe("generated-image");
    expect(out?.assetType).toBe("image");
    expect(out?.assetUrl).toBe("https://stub/img.png");
    expect(out?.fallbackReason).toBe("no AI video provider wired");
    expect(result.diagnostics?.warnings?.[0]).toContain(
      "no AI video provider wired",
    );
  });

  it("propagates repair semantics through the video → image fallback", async () => {
    const { ImageGenerationProviderError, normalizeImageGenerationError } =
      await import("../src/providers/image-generation-error.js");
    const policyError = new ImageGenerationProviderError(
      normalizeImageGenerationError({
        provider: "gemini",
        type: "content_policy",
        message: "Blocked by content policy.",
        originalPrompt: "Aerial drone footage of a coast.",
        sceneId: 1,
      }),
    );
    mockGenerateImage.mockRejectedValueOnce(policyError);
    const scene: Scene = {
      sceneId: 1,
      generationPrompt: "Aerial drone footage of a coast.",
      assetType: "video",
      assetMode: "source",
      filename: "scene-001.mp4",
    };
    const result = await runNode({ production: { scenes: [scene] } });
    const out = result.production?.scenes?.[0];
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    expect(mockGenerateVideo).not.toHaveBeenCalled();
    expect(out?.generationStatus).toBe("prompt_repair");
    expect(out?.providerError?.type).toBe("content_policy");
    // The fallback warning is NOT added because the scene did not
    // successfully complete via image — the repair warning replaces it.
    expect(result.diagnostics?.warnings?.[0]).not.toContain(
      "no AI video provider wired",
    );
  });
});
