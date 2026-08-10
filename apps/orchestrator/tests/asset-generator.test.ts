import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { assetGeneratorNode } from "../src/agents/asset-generator.node.js";
import type { ProjectState, Scene } from "../src/types/index.js";
import type { AssetProvider } from "../src/providers/asset-provider.js";
import { StubAssetProvider } from "../src/providers/stub-provider.js";

const SCENES: Scene[] = [
  { sceneId: 1, generationPrompt: "Aerial drone footage.", assetType: "video", filename: "scene-001.mp4", provider: "runway", generationMode: "generate", extension: "mp4", sceneType: "landscape" },
  { sceneId: 2, generationPrompt: "Detailed map.", assetType: "image", filename: "scene-002.png", provider: "gpt-image", generationMode: "generate", extension: "png", sceneType: "map" },
  { sceneId: 3, generationPrompt: "Close-up macro.", assetType: "video", filename: "scene-003.mp4", provider: "runway", generationMode: "generate", extension: "mp4", sceneType: "macro" },
];

const mockGenerateImage = jest.fn<(...args: any[]) => Promise<any>>();
const mockGenerateVideo = jest.fn<(...args: any[]) => Promise<any>>();

const mockAssetProvider: AssetProvider = {
  generateImage: mockGenerateImage,
  generateVideo: mockGenerateVideo,
};

beforeEach(() => {
  mockGenerateImage.mockReset();
  mockGenerateVideo.mockReset();
});

function runNode(state?: Partial<ProjectState>, provider?: AssetProvider) {
  return assetGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      production: { scenes: SCENES },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: { assetProvider: provider ?? mockAssetProvider } } as any,
  );
}

describe("assetGeneratorNode", () => {
  it("generates assets for all scenes", async () => {
    mockGenerateImage.mockResolvedValue({ url: "https://placeholder.local/scene-002.png" });
    mockGenerateVideo.mockResolvedValue({ url: "https://placeholder.local/scene-001.mp4" });

    const result = await runNode();

    expect(result.production?.scenes).toHaveLength(3);
    expect(result.production?.scenes![0].assetUrl).toBe("https://placeholder.local/scene-001.mp4");
    expect(result.production?.scenes![0].assetGeneratedAt).toBeDefined();
    expect(result.production?.scenes![1].assetUrl).toBe("https://placeholder.local/scene-002.png");
    expect(result.production?.scenes![1].assetGeneratedAt).toBeDefined();
    expect(result.production?.scenes![2].assetUrl).toBe("https://placeholder.local/scene-001.mp4");
    expect(result.execution?.currentNode).toBe("AssetGenerator");
    expect(mockGenerateVideo).toHaveBeenCalledTimes(2);
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
  });

  it("calls generateVideo for video assetType", async () => {
    mockGenerateImage.mockResolvedValue({ url: "https://placeholder.local/img.png" });
    mockGenerateVideo.mockResolvedValue({ url: "https://placeholder.local/vid.mp4" });

    await runNode();

    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Aerial drone footage.", sceneId: 1, filename: "scene-001.mp4" }),
    );
    expect(mockGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Detailed map.", sceneId: 2, filename: "scene-002.png" }),
    );
  });

  it("returns error when no scenes exist", async () => {
    const result = await runNode({ production: { scenes: [] } } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("No scenes");
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("handles partial failure gracefully", async () => {
    mockGenerateImage.mockResolvedValue({ url: "https://placeholder.local/img.png" });
    mockGenerateVideo
      .mockResolvedValueOnce({ url: "https://placeholder.local/scene-001.mp4" })
      .mockRejectedValueOnce(new Error("Generation timeout"));

    const result = await runNode();

    expect(result.production?.scenes![0].assetUrl).toBeUndefined();
    expect(result.production?.scenes![1].assetUrl).toBeUndefined();
    expect(result.production?.scenes![2].assetUrl).toBeUndefined();
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Scene 3");
    expect(result.diagnostics?.errors![0]).toContain("Generation timeout");
  });

  it("uses stub provider when no provider injected", async () => {
    const result = await assetGeneratorNode(
      { project: { pillar: "Geography", topic: "Test" }, production: { scenes: SCENES }, execution: { version: "0.1.0" } } as ProjectState,
      { configurable: { assetProvider: new StubAssetProvider() } } as any,
    );

    expect(result.production?.scenes![0].assetUrl).toContain("placeholder.local");
    expect(result.production?.scenes![1].assetUrl).toContain("placeholder.local");
  });

  it("sets assetUrl and assetGeneratedAt on each scene", async () => {
    mockGenerateImage.mockResolvedValue({ url: "https://placeholder.local/img.png" });
    mockGenerateVideo.mockResolvedValue({ url: "https://placeholder.local/vid.mp4" });

    const result = await runNode();

    for (const scene of result.production?.scenes ?? []) {
      expect(scene.assetUrl).toBeDefined();
      expect(scene.assetUrl).toContain("placeholder.local");
      expect(scene.assetGeneratedAt).toBeDefined();
      expect(scene.assetGeneratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("skips scenes missing generationPrompt", async () => {
    const incompleteScenes = [
      { ...SCENES[0] },
      { ...SCENES[1], generationPrompt: undefined },
    ];
    mockGenerateVideo.mockResolvedValue({ url: "https://placeholder.local/vid.mp4" });

    const result = await runNode({ production: { scenes: incompleteScenes } } as any);

    expect(result.production?.scenes![0].assetUrl).toBeUndefined();
    expect(result.production?.scenes![1].assetUrl).toBeUndefined();
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("missing generationPrompt");
  });

  it("records currentNode", async () => {
    mockGenerateImage.mockResolvedValue({ url: "https://placeholder.local/img.png" });
    mockGenerateVideo.mockResolvedValue({ url: "https://placeholder.local/vid.mp4" });

    const result = await runNode();

    expect(result.execution?.currentNode).toBe("AssetGenerator");
  });
});
