import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { metadataGeneratorNode } from "../src/agents/metadata-generator.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a YouTube SEO metadata specialist.",
  "---",
  "Script: {{script}}",
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

function runNode(state?: Partial<ProjectState>) {
  const mocks = makeMocks();
  const promise = metadataGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: {
        script: "Test script.",
        title: "Test Title",
        hook: "Test hook?",
      },
      branding: { channel: "TestChannel", creator: "", cta: "" },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: mocks } as any,
  );
  return { promise, mocks };
}

function buildLLMResponse(data: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(data) } }],
    usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
    model: "test-model",
  };
}

describe("metadataGeneratorNode", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("successful generation sets all metadata fields", async () => {
    const metadata = {
      title: "The Country That Doesn't Exist",
      description: "Discover this hidden geography fact.",
      tags: ["geography", "maps", "hidden places"],
      hashtags: ["geographyfacts", "hiddenhistory"],
      category: "Education",
      pinnedComment: "Which place surprised you the most?",
    };
    mockGenerate.mockResolvedValueOnce(buildLLMResponse(metadata));

    const { promise } = runNode();
    const result = await promise;

    expect(result.metadataOutput?.title).toBe(metadata.title);
    expect(result.metadataOutput?.description).toBe(metadata.description);
    expect(result.metadataOutput?.tags).toEqual(metadata.tags);
    expect(result.metadataOutput?.hashtags).toEqual(metadata.hashtags);
    expect(result.metadataOutput?.category).toBe("Education");
    expect(result.metadataOutput?.pinnedComment).toBe(metadata.pinnedComment);
    expect(result.execution?.currentNode).toBe("MetadataGenerator");
  });

  it("returns error when script missing", async () => {
    const { promise } = runNode({ content: { title: "T", hook: "H" } } as any);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("missing");
    expect(result.metadataOutput).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns error when title missing", async () => {
    const { promise } = runNode({ content: { script: "S", hook: "H" } } as any);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.metadataOutput).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns error when hook missing", async () => {
    const { promise } = runNode({
      content: { script: "S", title: "T" },
    } as any);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.metadataOutput).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("telemetry recorded", async () => {
    const metadata = {
      title: "T",
      description: "D",
      tags: [],
      hashtags: [],
      category: "Education",
      pinnedComment: "C",
    };
    mockGenerate.mockResolvedValueOnce(buildLLMResponse(metadata));

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.telemetry?.MetadataGenerator).toBeDefined();
  });

  it("schema validation rejects invalid data", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        title: "",
        description: "",
        tags: "not-array",
        hashtags: [],
        category: "",
        pinnedComment: "",
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.metadataOutput).toBeNull();
    expect(result.diagnostics?.errors).toBeDefined();
  });

  it("sets execution.currentNode", async () => {
    const metadata = {
      title: "T",
      description: "D",
      tags: [],
      hashtags: [],
      category: "Education",
      pinnedComment: "C",
    };
    mockGenerate.mockResolvedValueOnce(buildLLMResponse(metadata));

    const { promise } = runNode();
    const result = await promise;

    expect(result.execution?.currentNode).toBe("MetadataGenerator");
  });
});
