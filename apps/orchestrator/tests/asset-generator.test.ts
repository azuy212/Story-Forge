import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { assetGeneratorNode } from "../src/agents/asset-generator.node.js";
import type { ProjectState, Scene } from "../src/types/index.js";
import type { AssetProvider } from "../src/providers/asset-provider.js";
import { StubAssetProvider } from "../src/providers/stub-provider.js";
import {
  ImageGenerationProviderError,
  normalizeImageGenerationError,
} from "../src/providers/image-generation-error.js";

const SCENES: Scene[] = [
  {
    sceneId: 1,
    generationPrompt: "Aerial drone footage.",
    assetType: "video",
    filename: "scene-001.mp4",
    provider: "runway",
    generationMode: "generate",
    extension: "mp4",
    sceneType: "landscape",
  },
  {
    sceneId: 2,
    generationPrompt: "Detailed map.",
    assetType: "image",
    filename: "scene-002.png",
    provider: "gpt-image",
    generationMode: "generate",
    extension: "png",
    sceneType: "map",
  },
  {
    sceneId: 3,
    generationPrompt: "Close-up macro.",
    assetType: "video",
    filename: "scene-003.mp4",
    provider: "runway",
    generationMode: "generate",
    extension: "mp4",
    sceneType: "macro",
  },
];

const mockGenerateImage = jest.fn<(...args: any[]) => Promise<any>>();
const mockGenerateVideo = jest.fn<(...args: any[]) => Promise<any>>();

const mockAssetProvider: AssetProvider = {
  generateImage: mockGenerateImage,
  generateVideo: mockGenerateVideo,
};

const referenceAssetProvider: AssetProvider = {
  capabilities: { referenceImages: true, imageEditing: true },
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
    mockGenerateImage.mockResolvedValue({
      url: "https://placeholder.local/scene-002.png",
    });
    mockGenerateVideo.mockResolvedValue({
      url: "https://placeholder.local/scene-001.mp4",
    });

    const result = await runNode();

    expect(result.production?.scenes).toHaveLength(3);
    expect(result.production?.scenes![0].assetUrl).toBe(
      "https://placeholder.local/scene-001.mp4",
    );
    expect(result.production?.scenes![0].assetGeneratedAt).toBeDefined();
    expect(result.production?.scenes![1].assetUrl).toBe(
      "https://placeholder.local/scene-002.png",
    );
    expect(result.production?.scenes![1].assetGeneratedAt).toBeDefined();
    expect(result.production?.scenes![2].assetUrl).toBe(
      "https://placeholder.local/scene-001.mp4",
    );
    expect(result.execution?.currentNode).toBe("AssetGenerator");
    expect(mockGenerateVideo).toHaveBeenCalledTimes(2);
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
  });

  it("calls generateVideo for video assetType", async () => {
    mockGenerateImage.mockResolvedValue({
      url: "https://placeholder.local/img.png",
    });
    mockGenerateVideo.mockResolvedValue({
      url: "https://placeholder.local/vid.mp4",
    });

    await runNode();

    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Aerial drone footage.",
        sceneId: 1,
        filename: "scene-001.mp4",
      }),
    );
    expect(mockGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Detailed map.",
        sceneId: 2,
        filename: "scene-002.png",
      }),
    );
  });

  it("returns error when no scenes exist", async () => {
    const result = await runNode({ production: { scenes: [] } } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("No scenes");
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("routes a content-policy rejection to prompt repair, other scenes still resolve", async () => {
    const policyError = new ImageGenerationProviderError(
      normalizeImageGenerationError({
        provider: "gemini",
        type: "content_policy",
        message:
          "There are a lot of people I can help with, but I can't depict some public figures.",
        originalPrompt:
          "The supplied reference likeness of an old female psychologist.",
        sceneId: 2,
      }),
    );
    mockGenerateImage.mockRejectedValue(policyError);
    mockGenerateVideo.mockResolvedValue({
      url: "https://placeholder.local/scene-001.mp4",
    });

    const result = await runNode();

    const rejected = result.production?.scenes![1];
    expect(rejected?.generationStatus).toBe("prompt_repair");
    expect(rejected?.providerError).toMatchObject({
      type: "content_policy",
      provider: "gemini",
      message:
        "There are a lot of people I can help with, but I can't depict some public figures.",
    });
    expect(rejected?.originalPrompt).toBe("Detailed map.");
    expect(rejected?.promptAttempts?.[0]).toMatchObject({
      status: "rejected",
      errorType: "content_policy",
      prompt: "Detailed map.",
    });
    // The rejected prompt is never retried: exactly one provider call.
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    // Sibling scenes still generate; no batch-level error.
    expect(result.production?.scenes![0].assetUrl).toBeDefined();
    expect(result.production?.scenes![2].assetUrl).toBeDefined();
    expect(result.diagnostics?.errors).toBeUndefined();
  });

  it("fails a scene with unresolved rejection when the repair budget is exhausted", async () => {
    const policyError = new ImageGenerationProviderError(
      normalizeImageGenerationError({
        provider: "gemini",
        type: "content_policy",
        message: "Blocked by content policy.",
        originalPrompt: "Detailed map.",
        sceneId: 1,
      }),
    );
    mockGenerateImage.mockRejectedValue(policyError);

    const result = await runNode({
      production: {
        scenes: [
          {
            ...SCENES[1],
            repairCount: 2,
          },
        ],
      },
    } as any);

    const scene = result.production?.scenes![0];
    expect(scene?.generationStatus).toBe("failed");
    expect(scene?.failureType).toBe("unresolved_provider_rejection");
    expect(scene?.providerError?.type).toBe("content_policy");
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
  });

  it("aborts the batch on authentication failures but preserves completed scenes", async () => {
    const authError = new ImageGenerationProviderError(
      normalizeImageGenerationError({
        provider: "gemini",
        type: "authentication",
        message: "Sign in required.",
        originalPrompt: "Detailed map.",
        sceneId: 2,
      }),
    );
    mockGenerateImage.mockRejectedValue(authError);
    mockGenerateVideo.mockResolvedValue({
      url: "https://placeholder.local/scene-001.mp4",
    });

    const result = await runNode();

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("authentication");
    // The fatal scene is marked failed with the fatal type, never retried.
    expect(result.production?.scenes![1].generationStatus).toBe("failed");
    expect(result.production?.scenes![1].failureType).toBe("authentication");
    // Scenes that already generated keep their assets (partial progress
    // survives the batch abort).
    expect(result.production?.scenes![0].assetUrl).toBeDefined();
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures 4 times with stepwise backoff then marks the scene failed", async () => {
    jest.useFakeTimers();
    try {
      const transient = new ImageGenerationProviderError(
        normalizeImageGenerationError({
          provider: "gemini",
          type: "rate_limit",
          message: "Rate limited.",
          originalPrompt: "Detailed map.",
          sceneId: 2,
        }),
      );
      mockGenerateImage.mockRejectedValue(transient);
      mockGenerateVideo.mockResolvedValue({
        url: "https://placeholder.local/scene-001.mp4",
      });

      const promise = runNode();
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockGenerateImage).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(5000);
      expect(mockGenerateImage).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(15000);
      const result = await promise;

      const scene = result.production?.scenes![1];
      expect(scene?.generationStatus).toBe("failed");
      expect(scene?.failureType).toBe("provider_unavailable");
      expect(scene?.providerError?.type).toBe("rate_limit");
      expect(mockGenerateImage).toHaveBeenCalledTimes(4);
      expect(scene?.promptAttempts).toHaveLength(4);
      expect(scene?.promptAttempts?.every((a) => a.status === "rejected")).toBe(
        true,
      );
      expect(result.diagnostics?.errors).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it("skips scenes that already have assets", async () => {
    const result = await runNode({
      production: {
        scenes: [
          {
            ...SCENES[1],
            assetUrl: "https://existing.local/scene-002.png",
            generationStatus: "complete",
            promptAttempts: [
              {
                attempt: 1,
                prompt: "Detailed map.",
                status: "rejected",
                errorType: "content_policy",
              },
              {
                attempt: 2,
                prompt: "A clean map without public figures.",
                status: "success",
              },
            ],
          },
        ],
      },
    } as any);

    expect(result.production?.scenes![0].assetUrl).toBe(
      "https://existing.local/scene-002.png",
    );
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("uses stub provider when no provider injected", async () => {
    const result = await assetGeneratorNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        production: { scenes: SCENES },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: { assetProvider: new StubAssetProvider() } } as any,
    );

    expect(result.production?.scenes![0].assetUrl).toContain(
      "placeholder.local",
    );
    expect(result.production?.scenes![1].assetUrl).toContain(
      "placeholder.local",
    );
  });

  it("sets assetUrl and assetGeneratedAt on each scene", async () => {
    mockGenerateImage.mockResolvedValue({
      url: "https://placeholder.local/img.png",
    });
    mockGenerateVideo.mockResolvedValue({
      url: "https://placeholder.local/vid.mp4",
    });

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
    mockGenerateVideo.mockResolvedValue({
      url: "https://placeholder.local/vid.mp4",
    });

    const result = await runNode({
      production: { scenes: incompleteScenes },
    } as any);

    // The missing-prompt scene is fatal: the batch aborts but completed
    // scenes keep their assets (partial progress survives the abort).
    expect(result.production?.scenes![0].assetUrl).toBe(
      "https://placeholder.local/vid.mp4",
    );
    expect(result.production?.scenes![0].generationStatus).toBe("complete");
    expect(result.production?.scenes![1].assetUrl).toBeUndefined();
    expect(result.production?.scenes![1].generationStatus).toBe("failed");
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "missing generationPrompt",
    );
  });

  it("records currentNode", async () => {
    mockGenerateImage.mockResolvedValue({
      url: "https://placeholder.local/img.png",
    });
    mockGenerateVideo.mockResolvedValue({
      url: "https://placeholder.local/vid.mp4",
    });

    const result = await runNode();

    expect(result.execution?.currentNode).toBe("AssetGenerator");
  });

  it("uses source image directly for source mode", async () => {
    const result = await runNode({
      production: {
        scenes: [
          {
            sceneId: 1,
            generationPrompt: "Use source portrait.",
            assetType: "image",
            assetMode: "source",
            filename: "scene-001.png",
            sourceAssetIds: ["source-1"],
          },
        ],
        sourceAssets: [
          {
            id: "source-1",
            url: "https://commons.wikimedia.org/source.png",
            source: "Wikimedia Commons",
            license: "CC BY-SA",
            attribution: "Archive",
            localPath: "/tmp/source-1.png",
          },
        ],
      },
    } as any);

    expect(result.production?.scenes![0].assetUrl).toBe("/tmp/source-1.png");
    expect(result.production?.scenes![0].assetKind).toBe("source-image");
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("passes source image reference for supported composite provider", async () => {
    mockGenerateImage.mockResolvedValue({ url: "/tmp/composite.png" });

    const result = await runNode(
      {
        production: {
          scenes: [
            {
              sceneId: 1,
              generationPrompt:
                "Place subject in a period study, vertical portrait 9:16.",
              assetType: "image",
              assetMode: "source_composite",
              filename: "scene-001.png",
              sourceAssetIds: ["source-1"],
            },
          ],
          sourceAssets: [
            {
              id: "source-1",
              url: "https://commons.wikimedia.org/source.png",
              source: "Wikimedia Commons",
              localPath: "/tmp/source-1.png",
            },
          ],
        },
      } as any,
      referenceAssetProvider,
    );

    expect(mockGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "image_to_image",
        referenceImages: [
          expect.objectContaining({
            id: "source-1",
            path: "/tmp/source-1.png",
          }),
        ],
      }),
    );
    expect(result.production?.scenes![0].assetKind).toBe("source-composite");
  });

  it("falls back to source when provider lacks reference support", async () => {
    const result = await runNode({
      production: {
        scenes: [
          {
            sceneId: 1,
            generationPrompt:
              "Place subject in a study, vertical portrait 9:16.",
            assetType: "image",
            assetMode: "source_composite",
            filename: "scene-001.png",
            sourceAssetIds: ["source-1"],
          },
        ],
        sourceAssets: [
          {
            id: "source-1",
            url: "https://commons.wikimedia.org/source.png",
            source: "Wikimedia Commons",
            localPath: "/tmp/source-1.png",
          },
        ],
      },
    } as any);

    expect(result.production?.scenes![0].assetUrl).toBe("/tmp/source-1.png");
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("routes a reference-mode content-policy rejection to repair, never source fallback", async () => {
    const policyError = new ImageGenerationProviderError(
      normalizeImageGenerationError({
        provider: "gemini",
        type: "content_policy",
        message: "Blocked by content policy.",
        originalPrompt: "Place subject in a study, vertical portrait 9:16.",
        sceneId: 1,
      }),
    );
    mockGenerateImage.mockRejectedValue(policyError);

    const result = await runNode(
      {
        production: {
          scenes: [
            {
              sceneId: 1,
              generationPrompt:
                "Place subject in a study, vertical portrait 9:16.",
              assetType: "image",
              assetMode: "source_edit",
              filename: "scene-001.png",
              sourceAssetIds: ["source-1"],
            },
          ],
          sourceAssets: [
            {
              id: "source-1",
              url: "https://commons.wikimedia.org/source.png",
              source: "Wikimedia Commons",
              localPath: "/tmp/source-1.png",
            },
          ],
        },
      } as any,
      referenceAssetProvider,
    );

    const scene = result.production?.scenes![0];
    expect(scene?.generationStatus).toBe("prompt_repair");
    expect(scene?.assetUrl).toBeUndefined();
    expect(scene?.providerError?.type).toBe("content_policy");
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
  });

  it("aborts on a fatal reference-mode error instead of swallowing it", async () => {
    const authError = new ImageGenerationProviderError(
      normalizeImageGenerationError({
        provider: "gemini",
        type: "authentication",
        message: "Sign in required.",
        originalPrompt: "Place subject in a study, vertical portrait 9:16.",
        sceneId: 1,
      }),
    );
    mockGenerateImage.mockRejectedValue(authError);

    const result = await runNode(
      {
        production: {
          scenes: [
            {
              sceneId: 1,
              generationPrompt:
                "Place subject in a study, vertical portrait 9:16.",
              assetType: "image",
              assetMode: "source_edit",
              filename: "scene-001.png",
              sourceAssetIds: ["source-1"],
            },
          ],
          sourceAssets: [
            {
              id: "source-1",
              url: "https://commons.wikimedia.org/source.png",
              source: "Wikimedia Commons",
              localPath: "/tmp/source-1.png",
            },
          ],
        },
      } as any,
      referenceAssetProvider,
    );

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("authentication");
    const scene = result.production?.scenes![0];
    expect(scene?.assetUrl).toBeUndefined();
    expect(scene?.generationStatus).toBe("failed");
    expect(scene?.failureType).toBe("authentication");
  });
});
