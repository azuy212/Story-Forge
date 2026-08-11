import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  isUsableThumbnailImage,
  thumbnailGeneratorNode,
} from "../src/agents/thumbnail-generator.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a YouTube thumbnail designer.",
  "---",
  "Title: {{title}}",
].join("\n");

function makeMocks() {
  const createModel = jest.fn<
    (...args: any[]) => { model: string; generate: typeof mockGenerate }
  >(() => ({
    model: "test-model",
    generate: mockGenerate,
  }));
  const loadPrompt = jest
    .fn<(...args: any[]) => Promise<string>>()
    .mockImplementation(() => Promise.resolve(MOCK_PROMPT));
  return { createModel, loadPrompt };
}

function runNode(
  state?: Partial<ProjectState>,
  compositorOverrides?: Record<string, unknown>,
  configOverrides?: Record<string, unknown>,
) {
  const mocks = makeMocks();
  const assetProvider = {
    generateImage: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ url: "https://placeholder.local/thumbnail.png" }),
    generateVideo: jest.fn<(...args: any[]) => Promise<any>>(),
  };
  const compositor = {
    version: "1.0.0",
    fingerprint: jest.fn<(...args: any[]) => string>(() => "test-compositor"),
    composite: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockImplementation(async (opts: any) => ({
        url: opts.sourceUrl,
        width: 1080,
        height: 1920,
      })),
    ...compositorOverrides,
  };
  const promise = thumbnailGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: {
        title: "Test Title",
        hook: "Test hook?",
        narration: "Test narration.",
      },
      branding: {
        channel: "TestChannel",
        creator: "",
        cta: "",
        style: "Documentary",
        colorPalette: "Cold blue",
      },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    {
      configurable: {
        ...mocks,
        assetProvider,
        thumbnailCompositor: compositor,
        ...configOverrides,
      },
    } as any,
  );
  return { promise, mocks, assetProvider, compositor };
}

function buildLLMResponse(data: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(data) } }],
    usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
    model: "test-model",
  };
}

describe("thumbnailGeneratorNode", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("rejects cached local thumbnail paths that no longer exist", () => {
    expect(
      isUsableThumbnailImage({
        sourceUrl: "/tmp/source.png",
        imageUrl: "/tmp/missing-thumbnail.png",
        width: 1080,
        height: 1920,
        text: "T",
        textPosition: "center",
        compositorVersion: "1.0.0",
      }),
    ).toBe(false);
  });

  it("accepts cached provider thumbnail URLs", () => {
    expect(
      isUsableThumbnailImage({
        sourceUrl: "https://cdn.local/source.png",
        imageUrl: "https://cdn.local/thumbnail.png",
        width: 1080,
        height: 1920,
        text: "T",
        textPosition: "center",
        compositorVersion: "1.0.0",
      }),
    ).toBe(true);
  });

  it("successful generation sets all thumbnail fields", async () => {
    const output = {
      thumbnailPrompt:
        "High contrast aerial view of remote island. Dramatic shadows. Cold blue tones.",
      thumbnailText: "Doesn't Exist?",
      textPosition: "bottom-third",
      colorScheme: "cold blue and white",
    };
    mockGenerate.mockResolvedValueOnce(buildLLMResponse(output));

    const { promise, assetProvider, compositor } = runNode();
    const result = await promise;

    expect(result.thumbnail.thumbnailPrompt).toBe(output.thumbnailPrompt);
    expect(result.thumbnail.thumbnailText).toBe(output.thumbnailText);
    expect(result.thumbnail.textPosition).toBe("bottom-third");
    expect(result.thumbnail.colorScheme).toBe("cold blue and white");
    expect(result.thumbnail.imageUrl).toBe(
      "https://placeholder.local/thumbnail.png",
    );
    expect(result.thumbnail.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.execution?.currentNode).toBe("ThumbnailGenerator");

    const [generateCall] = assetProvider.generateImage.mock.calls.at(-1)!;
    expect(generateCall.sceneId).toBe(0);
    expect(generateCall.filename).toBe("thumbnail.png");
    // Authoritative generation prompt preserves the LLM scene prompt and
    // appends pipeline overlay instructions.
    expect(generateCall.prompt).toContain(output.thumbnailPrompt);
    expect(generateCall.prompt).toContain('overlay text "Doesn\'t Exist?"');
    expect(generateCall.prompt).toContain("1080x1920");
    expect(generateCall.prompt).toContain("Do NOT render any text");

    expect(compositor.composite).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: "https://placeholder.local/thumbnail.png",
        text: "Doesn't Exist?",
        textPosition: "bottom-third",
        filename: "thumbnail-composited.png",
      }),
    );
  });

  it("persists composited image as thumbnailImage artifact", async () => {
    const output = {
      thumbnailPrompt: "P",
      thumbnailText: "T",
      textPosition: "center",
      colorScheme: "blue",
    };
    const saved: Array<{ type: string; data: Record<string, unknown> }> = [];
    const artifactStore = {
      latest: jest.fn(async (..._args: any[]) => null),
      save: jest.fn(
        async (_runId: string, type: string, data: Record<string, unknown>) => {
          saved.push({ type, data });
          return {
            artifactId: "thumbnail-artifact",
            type,
            version: 1,
            location: "/tmp/thumbnail-artifact.json",
            runId: "thumbnail-artifact-test",
          };
        },
      ),
      recordRef: jest.fn(async (..._args: any[]) => undefined),
    };
    mockGenerate.mockResolvedValueOnce(buildLLMResponse(output));

    const { promise } = runNode(
      {},
      {
        composite: jest
          .fn<(...args: any[]) => Promise<any>>()
          .mockResolvedValue({
            url: "https://cdn.local/thumbnail-composited.png",
            width: 1080,
            height: 1920,
          }),
      },
      { runId: "thumbnail-artifact-test", artifactStore },
    );
    const result = await promise;

    expect(result.thumbnail.imageUrl).toBe(
      "https://cdn.local/thumbnail-composited.png",
    );
    expect(saved).toEqual(
      expect.arrayContaining([
        {
          type: "thumbnailImage",
          data: expect.objectContaining({
            imageUrl: "https://cdn.local/thumbnail-composited.png",
            width: 1080,
            height: 1920,
          }),
        },
      ]),
    );
  });

  it("normalizes unknown textPosition to bottom-third for the compositor", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "weird-spot",
        colorScheme: "blue",
      }),
    );

    const { promise, compositor } = runNode();
    const result = await promise;

    expect(result.thumbnail.textPosition).toBe("bottom-third");
    expect(compositor.composite).toHaveBeenCalledWith(
      expect.objectContaining({ textPosition: "bottom-third" }),
    );
  });

  it("compositor failure fails the thumbnail node (no raw fallback)", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const failing = {
      composite: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockRejectedValue(new Error("drawtext font missing")),
    };
    const { promise } = runNode({}, failing);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Image generation failed");
    expect(result.diagnostics?.errors![0]).toContain("drawtext font missing");
    expect(result.thumbnail.imageUrl).toBeUndefined();
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
  });

  it("rejects non-canonical compositor dimensions", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const invalid = {
      composite: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        url: "/tmp/thumbnail.png",
        width: 720,
        height: 1280,
      }),
    };
    const { promise } = runNode({}, invalid);
    const result = await promise;

    expect(result.diagnostics?.errors?.[0]).toContain("expected 1080x1920");
    expect(result.thumbnail.imageUrl).toBeUndefined();
  });

  it("returns error when title missing", async () => {
    const { promise } = runNode({ content: { hook: "H" } } as any);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Title is missing");
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("LLM failure returns error", async () => {
    mockGenerate.mockRejectedValue(new Error("Generation failed"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Generation failed");
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
  });

  it("telemetry recorded", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.telemetry?.ThumbnailGenerator).toBeDefined();
  });

  it("image generation failure returns error", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise, assetProvider } = runNode();
    assetProvider.generateImage.mockRejectedValueOnce(
      new Error("API quota exceeded"),
    );

    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Image generation failed");
    expect(result.diagnostics?.errors![0]).toContain("API quota exceeded");
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
  });

  it("sets execution.currentNode", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.execution?.currentNode).toBe("ThumbnailGenerator");
  });

  it("generatedAt is valid ISO timestamp", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.thumbnail.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
