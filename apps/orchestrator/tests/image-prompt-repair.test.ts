import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { imagePromptRepairNode } from "../src/agents/image-prompt-repair.node.js";
import type { ProjectState, Scene } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are an image-generation prompt repair specialist.",
  "---",
  "Scene ID: {{sceneId}}",
  "Original prompt: {{originalPrompt}}",
  "Provider error: {{providerError}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const REPAIRABLE_SCENE: Scene = {
  sceneId: 6,
  generationPrompt:
    "The supplied reference likeness of an old female psychologist.",
  originalPrompt:
    "The supplied reference likeness of an old female psychologist.",
  generationStatus: "prompt_repair",
  providerError: {
    provider: "gemini",
    type: "content_policy",
    message:
      "There are a lot of people I can help with, but I can't depict some public figures.",
    retryable: false,
  },
  repairCount: 0,
  promptAttempts: [
    {
      attempt: 1,
      prompt: "The supplied reference likeness of an old female psychologist.",
      status: "rejected",
      errorType: "content_policy",
      providerMessage:
        "There are a lot of people I can help with, but I can't depict some public figures.",
    },
  ],
};

const REPAIR_OUTPUT = {
  repairedPrompt:
    "An original fictional elderly female psychologist with a non-identifiable appearance.",
  changes: ["Removed reference-likeness language"],
  reason: "Provider rejects public-figure likenesses.",
  shouldRetry: true,
};

function makeMocks(output: unknown = REPAIR_OUTPUT) {
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
  mockGenerate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(output) } }],
  });
  return { createModel, loadPrompt };
}

function runNode(scenes: Scene[], state?: Partial<ProjectState>) {
  const { createModel, loadPrompt } = makeMocks();
  return imagePromptRepairNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      production: { scenes },
      ...state,
    } as ProjectState,
    {
      configurable: { createModel, loadPrompt },
    } as any,
  );
}

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("imagePromptRepairNode", () => {
  it("repairs a rejected prompt and returns the scene to pending", async () => {
    const result = await runNode([REPAIRABLE_SCENE]);

    const scene = result.production?.scenes![0];
    expect(scene?.generationPrompt).toBe(REPAIR_OUTPUT.repairedPrompt);
    expect(scene?.repairedPrompt).toBe(REPAIR_OUTPUT.repairedPrompt);
    expect(scene?.repairCount).toBe(1);
    expect(scene?.generationStatus).toBe("pending");
    expect(scene?.originalPrompt).toBe(
      "The supplied reference likeness of an old female psychologist.",
    );
    expect(scene?.providerError).toBeUndefined();
    // Original prompt + attempts are preserved, not overwritten.
    expect(scene?.promptAttempts?.[0].status).toBe("rejected");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("preserves non-repairable scenes untouched", async () => {
    const complete: Scene = {
      sceneId: 3,
      generationPrompt: "A map.",
      assetUrl: "https://existing.local/map.png",
      generationStatus: "complete",
    };
    const result = await runNode([complete, REPAIRABLE_SCENE]);

    expect(result.production?.scenes![0].assetUrl).toBe(
      "https://existing.local/map.png",
    );
    expect(result.production?.scenes![1].generationStatus).toBe("pending");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the repair LLM call fails", async () => {
    const { createModel, loadPrompt } = makeMocks();
    mockGenerate.mockRejectedValue(new Error("LLM unavailable"));
    const result = await imagePromptRepairNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        production: { scenes: [REPAIRABLE_SCENE] },
      } as ProjectState,
      { configurable: { createModel, loadPrompt } } as any,
    );

    const scene = result.production?.scenes![0];
    expect(scene?.generationStatus).toBe("failed");
    expect(scene?.failureType).toBe("prompt_repair_failed");
  });

  it("fails closed when the repair model says not to retry", async () => {
    const { createModel, loadPrompt } = makeMocks({
      ...REPAIR_OUTPUT,
      shouldRetry: false,
    });
    const result = await imagePromptRepairNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        production: { scenes: [REPAIRABLE_SCENE] },
      } as ProjectState,
      { configurable: { createModel, loadPrompt } } as any,
    );

    const scene = result.production?.scenes![0];
    expect(scene?.generationStatus).toBe("failed");
    expect(scene?.failureType).toBe("unresolved_provider_rejection");
  });

  it("applies the final repair and returns to pending for the generator to attempt", async () => {
    const result = await runNode([
      {
        ...REPAIRABLE_SCENE,
        repairCount: 1,
      },
    ]);

    // Budget counts LLM repairs; the final repaired prompt is still returned
    // to pending so AssetGenerator attempts it. Only a rejection past the
    // ceiling (repairCount >= MAX_PROMPT_REPAIRS) fails the scene.
    const scene = result.production?.scenes![0];
    expect(scene?.repairCount).toBe(2);
    expect(scene?.generationStatus).toBe("pending");
    expect(scene?.generationPrompt).toBe(REPAIR_OUTPUT.repairedPrompt);
    expect(scene?.failureType).toBeUndefined();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the repair model repeats a prior attempt", async () => {
    const result = await runNode([
      {
        ...REPAIRABLE_SCENE,
        promptAttempts: [
          ...(REPAIRABLE_SCENE.promptAttempts ?? []),
          {
            attempt: 2,
            prompt: REPAIR_OUTPUT.repairedPrompt,
            status: "rejected",
            errorType: "content_policy",
          },
        ],
      },
    ]);

    const scene = result.production?.scenes![0];
    expect(scene?.generationStatus).toBe("failed");
    expect(scene?.failureType).toBe("unresolved_provider_rejection");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no scene needs repair", async () => {
    const pending: Scene = {
      sceneId: 6,
      generationPrompt: "A map.",
      generationStatus: "pending",
    };
    const result = await runNode([pending]);

    expect(result.production?.scenes![0].generationStatus).toBe("pending");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("fails a repair-flagged scene that lacks a provider error", async () => {
    const result = await runNode([
      { ...REPAIRABLE_SCENE, providerError: undefined },
    ]);

    const scene = result.production?.scenes![0];
    expect(scene?.generationStatus).toBe("failed");
    expect(scene?.failureType).toBe("invalid_repair_state");
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
