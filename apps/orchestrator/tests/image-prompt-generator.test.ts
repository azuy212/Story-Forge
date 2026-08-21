import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { imagePromptGeneratorNode } from "../src/agents/image-prompt-generator.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a cinematic prompt engineer.",
  "---",
  "Pillar: {{pillar}}",
  "Topic: {{topic}}",
  "Style: {{style}}",
  "Palette: {{colorPalette}}",
  "QA Feedback: {{qaFeedback}}",
  "Previous Prompts: {{previousPrompts}}",
  "Scenes: {{scenes}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const BASE_SCENES = [
  {
    sceneId: 1,
    startSecond: 0,
    endSecond: 8,
    durationSeconds: 8,
    narration: "What if a country...",
    visualDescription: "Satellite view",
    sceneType: "landscape",
    emphasis: "medium" as const,
  },
  {
    sceneId: 2,
    startSecond: 8,
    endSecond: 20,
    durationSeconds: 12,
    narration: "The nation...",
    visualDescription: "Map fading",
    sceneType: "map",
    emphasis: "high" as const,
  },
];

function makeMocks() {
  const createModel = jest.fn<
    (...args: any[]) => { model: string; generate: typeof mockGenerate }
  >(() => ({
    model: "test-model",
    generate: mockGenerate,
  }));
  const loadPrompt = jest
    .fn<(...args: any[]) => Promise<string>>()
    .mockImplementation((path: string) => {
      if (path.includes("editorial-guidelines"))
        return Promise.resolve(MOCK_GUIDELINES);
      return Promise.resolve(MOCK_PROMPT);
    });
  return { createModel, loadPrompt };
}

function runNode(state?: Partial<ProjectState>) {
  const mocks = makeMocks();
  const promise = imagePromptGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Unrecognized Countries" },
      branding: {
        channel: "Universe Decoded",
        creator: "",
        cta: "",
        style: "Documentary",
        colorPalette: "Cold blue",
        logo: "UD logo",
      },
      content: {
        title: "Title",
        hook: "Hook",
        script: "Script.",
        narration: "Narration.",
        callToAction: "CTA",
        estimatedDurationSeconds: 20,
      },
      production: { scenes: BASE_SCENES },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: mocks } as any,
  );
  return { promise, mocks };
}

function buildResponse(overrides?: {
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
}) {
  const promptTokens = overrides?.promptTokens ?? 15;
  const completionTokens = overrides?.completionTokens ?? 30;
  return {
    output:
      overrides?.content ??
      JSON.stringify({
        assets: [
          {
            sceneId: 1,
            assetType: "image",
            generationPrompt:
              "Ultra detailed Satellite view of Eastern Europe at night. Cold blue atmosphere. Documentary realism. High contrast. National Geographic style. No text.",
          },
          {
            sceneId: 2,
            assetType: "image",
            generationPrompt:
              "Detailed political map of Moldova and Transnistria. Clean borders. Cartographic style. Documentary aesthetic. Educational. No watermark.",
          },
        ],
      }),
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("imagePromptGeneratorNode", () => {
  it("returns enriched scenes with prompts on success", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes).toHaveLength(2);
    expect(result.production?.scenes![0].generationPrompt).toContain(
      "Satellite view",
    );
    expect(result.production?.scenes![0].assetType).toBe("image");
    expect(result.production?.scenes![0].promptId).toBe("prompt-scene-001");
    expect(result.production?.scenes![1].generationPrompt).toContain(
      "political map",
    );
    expect(result.production?.scenes![1].assetType).toBe("image");
    expect(result.production?.scenes![1].promptId).toBe("prompt-scene-002");
    expect(result.execution?.currentNode).toBe("ImagePromptGenerator");
    expect(result.diagnostics?.telemetry?.ImagePromptGenerator).toBeDefined();
    expect(result.diagnostics?.errors).toBeUndefined();
  });

  it("passes branding and scenes to the model", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    await promise;

    const calls = mockGenerate.mock.calls;
    const messages = calls[0][0] as { role: string; content: string }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("Documentary");
    expect(userMsg!.content).toContain("Cold blue");
    expect(userMsg!.content).toContain("Satellite view");
  });

  it("attaches the previous prompts on minor_revision", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode({
      production: {
        scenes: [
          {
            ...BASE_SCENES[0],
            sceneType: "landscape" as const,
            generationPrompt: "OLD PROMPT CONTENT scene 1 portrait 9:16.",
          },
          {
            ...BASE_SCENES[1],
            sceneType: "map" as const,
            generationPrompt: "OLD PROMPT CONTENT scene 2 portrait 9:16.",
          },
        ],
        promptQA: {
          status: "minor_revision",
          globalFeedback: "Revise flagged scenes.",
          issues: ["Scene 2 coverage"],
          sceneResults: [],
        },
      },
    });
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("OLD PROMPT CONTENT scene 1");
    expect(userMsg!.content).toContain("OLD PROMPT CONTENT scene 2");
  });

  it("does not attach previous prompts on a fresh run", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).not.toContain("OLD PROMPT CONTENT");
  });

  it("uses json_object response format", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    await promise;

    const options = mockGenerate.mock.calls[0][1] as Record<string, unknown>;
    expect((options?.responseFormat as any)?.type).toBe("json_object");
  });

  it("retries once after invalid JSON, succeeds on second attempt", async () => {
    mockGenerate
      .mockResolvedValueOnce(buildResponse({ content: "not json" }))
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes![0].generationPrompt).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ImagePromptGenerator.retries).toBe(1);
  });

  it("retries once after schema validation failure", async () => {
    mockGenerate
      .mockResolvedValueOnce(
        buildResponse({
          content: JSON.stringify({
            assets: [
              { sceneId: 1, assetType: "image", generationPrompt: "short" },
            ],
          }),
        }),
      )
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes![0].generationPrompt).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ImagePromptGenerator.retries).toBe(1);
  });

  it("returns error for duplicate sceneIds in LLM output", async () => {
    const dupContent = JSON.stringify({
      assets: [
        {
          sceneId: 1,
          assetType: "image",
          generationPrompt:
            "Ultra detailed satellite view of Eastern Europe at night. Cold blue atmosphere. Documentary realism.",
        },
        {
          sceneId: 1,
          assetType: "image",
          generationPrompt:
            "Another prompt for the same scene. Extra text here to reach min length. More filler.",
        },
      ],
    });
    mockGenerate
      .mockResolvedValueOnce(buildResponse({ content: dupContent }))
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes![0].generationPrompt).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("clears stale prompts and writes error after both attempts fail", async () => {
    mockGenerate.mockResolvedValue(buildResponse({ content: "bad json" }));

    const { promise } = runNode();
    const result = await promise;

    expect(
      result.production?.scenes?.every((s) => s.generationPrompt === undefined),
    ).toBe(true);
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors!.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics?.errors![0]).toContain("ImagePromptGenerator");
    expect(result.diagnostics?.telemetry?.ImagePromptGenerator.retries).toBe(1);
  });

  it("clears stale prompts on failure", async () => {
    mockGenerate.mockRejectedValue(new Error("OpenRouter timeout"));

    const { promise } = runNode();
    const result = await promise;

    expect(
      result.production?.scenes?.every((s) => s.generationPrompt === undefined),
    ).toBe(true);
    expect(result.diagnostics?.errors![0]).toContain("OpenRouter timeout");
  });

  it("handles empty response (no content in message)", async () => {
    mockGenerate.mockResolvedValue({
      output: null,
    });

    const { promise } = runNode();
    const result = await promise;

    expect(
      result.production?.scenes?.every((s) => s.generationPrompt === undefined),
    ).toBe(true);
    expect(result.diagnostics?.errors).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("handles empty scenes gracefully", async () => {
    const { promise } = runNode({ production: { scenes: [] } } as any);
    const result = await promise;

    expect(result.diagnostics?.errors![0]).toContain("No scenes to process");
  });

  it("telemetry records promptVersion and agentVersion", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    const telemetry = result.diagnostics?.telemetry?.ImagePromptGenerator;
    expect(telemetry).toBeDefined();
    expect(telemetry!.durationMs).toBeGreaterThanOrEqual(0);
    expect(telemetry!.promptVersion).toBe("image-prompt-generator/v1");
    expect(telemetry!.agentVersion).toBe("1.0.0");
  });

  it("loads prompt from expected path", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise, mocks } = runNode();
    await promise;

    expect(mocks.loadPrompt).toHaveBeenCalledWith(
      "image-prompt-generator/v1.md",
    );
  });

  it("returns error when LLM returns only subset of scenes", async () => {
    const partial = JSON.stringify({
      assets: [
        {
          sceneId: 1,
          assetType: "image",
          generationPrompt:
            "Ultra detailed satellite view of Eastern Europe at night. Cold blue atmosphere. Documentary realism.",
        },
      ],
    });
    mockGenerate.mockResolvedValue(buildResponse({ content: partial }));

    const { promise } = runNode();
    const result = await promise;

    expect(
      result.production?.scenes?.every((s) => s.generationPrompt === undefined),
    ).toBe(true);
    expect(result.diagnostics?.errors![0]).toContain(
      "Incomplete asset mapping",
    );
    expect(result.diagnostics?.errors![0]).toContain("Missing scenes: [2]");
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ImagePromptGenerator.retries).toBe(1);
  });

  it("drops unknown sceneIds and completes when known scenes are covered", async () => {
    const extraContent = JSON.stringify({
      assets: [
        {
          sceneId: 1,
          assetType: "image",
          generationPrompt:
            "Ultra detailed satellite view of Eastern Europe at night. Cold blue atmosphere. Documentary realism.",
        },
        {
          sceneId: 99,
          assetType: "image",
          generationPrompt:
            "Unknown scene. Extra text here to reach min length requirement easily. More filler.",
        },
        {
          sceneId: 2,
          assetType: "image",
          generationPrompt:
            "Detailed political map of Moldova and Transnistria. Clean borders. Cartographic style. Documentary aesthetic. Educational. No watermark.",
        },
      ],
    });
    mockGenerate.mockResolvedValue(buildResponse({ content: extraContent }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes![0].generationPrompt).toContain(
      "satellite view",
    );
    expect(result.production?.scenes![1].generationPrompt).toContain(
      "political map",
    );
    expect(result.diagnostics?.errors).toBeUndefined();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("fails when unknown sceneIds leave known scenes missing", async () => {
    const extraContent = JSON.stringify({
      assets: [
        {
          sceneId: 1,
          assetType: "image",
          generationPrompt:
            "Ultra detailed satellite view of Eastern Europe at night. Cold blue atmosphere. Documentary realism.",
        },
        {
          sceneId: 99,
          assetType: "image",
          generationPrompt:
            "Unknown scene. Extra text here to reach min length requirement easily. More filler.",
        },
      ],
    });
    mockGenerate.mockResolvedValue(buildResponse({ content: extraContent }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.errors![0]).toContain(
      "Incomplete asset mapping",
    );
    expect(result.diagnostics?.errors![0]).toContain("Missing scenes: [2]");
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("recovers from incomplete mapping on retry", async () => {
    const partial = JSON.stringify({
      assets: [
        {
          sceneId: 1,
          assetType: "image",
          generationPrompt:
            "Ultra detailed satellite view of Eastern Europe at night. Cold blue atmosphere. Documentary realism.",
        },
      ],
    });
    mockGenerate
      .mockResolvedValueOnce(buildResponse({ content: partial }))
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.scenes![0].generationPrompt).toContain(
      "Satellite view",
    );
    expect(result.production?.scenes![1].generationPrompt).toContain(
      "political map",
    );
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ImagePromptGenerator.retries).toBe(1);
  });
});
