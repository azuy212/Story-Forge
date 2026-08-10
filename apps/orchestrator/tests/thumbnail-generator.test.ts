import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { thumbnailGeneratorNode } from "../src/agents/thumbnail-generator.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a YouTube thumbnail designer.",
  "---",
  "Title: {{title}}",
].join("\n");

function makeMocks() {
  const createModel = jest.fn<(...args: any[]) => { model: string; generate: typeof mockGenerate }>(() => ({
    model: "test-model",
    generate: mockGenerate,
  }));
  const loadPrompt = jest
    .fn<(...args: any[]) => Promise<string>>()
    .mockImplementation(() => Promise.resolve(MOCK_PROMPT));
  return { createModel, loadPrompt };
}

function runNode(state?: Partial<ProjectState>) {
  const mocks = makeMocks();
  const assetProvider = {
    generateImage: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ url: "https://placeholder.local/thumbnail.png" }),
    generateVideo: jest.fn<(...args: any[]) => Promise<any>>(),
  };
  const promise = thumbnailGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: { title: "Test Title", hook: "Test hook?", narration: "Test narration." },
      branding: { channel: "TestChannel", creator: "", cta: "", style: "Documentary", colorPalette: "Cold blue" },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: { ...mocks, assetProvider } } as any,
  );
  return { promise, mocks, assetProvider };
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

  it("successful generation sets all thumbnail fields", async () => {
    const output = {
      thumbnailPrompt: "High contrast aerial view of remote island. Dramatic shadows. Cold blue tones.",
      thumbnailText: "Doesn't Exist?",
      textPosition: "bottom-third",
      colorScheme: "cold blue and white",
    };
    mockGenerate.mockResolvedValueOnce(buildLLMResponse(output));

    const { promise, assetProvider } = runNode();
    const result = await promise;

    expect(result.thumbnail.thumbnailPrompt).toBe(output.thumbnailPrompt);
    expect(result.thumbnail.thumbnailText).toBe(output.thumbnailText);
    expect(result.thumbnail.textPosition).toBe("bottom-third");
    expect(result.thumbnail.colorScheme).toBe("cold blue and white");
    expect(result.thumbnail.imageUrl).toBe("https://placeholder.local/thumbnail.png");
    expect(result.thumbnail.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.execution?.currentNode).toBe("ThumbnailGenerator");
    expect(assetProvider.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: output.thumbnailPrompt, sceneId: 0, filename: "thumbnail.png" }),
    );
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
      buildLLMResponse({ thumbnailPrompt: "P", thumbnailText: "T", textPosition: "center", colorScheme: "blue" }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.telemetry?.ThumbnailGenerator).toBeDefined();
  });

  it("image generation failure returns error", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({ thumbnailPrompt: "P", thumbnailText: "T", textPosition: "center", colorScheme: "blue" }),
    );

    const { promise, assetProvider } = runNode();
    assetProvider.generateImage.mockRejectedValueOnce(new Error("API quota exceeded"));

    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Image generation failed");
    expect(result.diagnostics?.errors![0]).toContain("API quota exceeded");
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
  });

  it("sets execution.currentNode", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({ thumbnailPrompt: "P", thumbnailText: "T", textPosition: "center", colorScheme: "blue" }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.execution?.currentNode).toBe("ThumbnailGenerator");
  });

  it("generatedAt is valid ISO timestamp", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({ thumbnailPrompt: "P", thumbnailText: "T", textPosition: "center", colorScheme: "blue" }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.thumbnail.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

});
