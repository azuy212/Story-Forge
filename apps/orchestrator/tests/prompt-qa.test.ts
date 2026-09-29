import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { promptQANode } from "../src/agents/prompt-qa.node.js";
import type { ProjectState, Scene } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a prompt QA reviewer.",
  "---",
  "Scenes: {{scenes}}",
  "Visual Plan: {{visualPlan}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const SCENES: Scene[] = [
  {
    sceneId: 1,
    generationPrompt:
      "Aerial drone footage of remote island. Cinematic documentary style.",
    assetType: "video",
    sceneType: "landscape",
    visualDescription: "Aerial view of island",
    narration: "Narration 1",
    sceneGoal: "Hook",
    cameraShot: "aerial",
    cameraMotion: "drone-flyover",
    emphasis: "high",
    references: ["fact-001"],
  },
  {
    sceneId: 2,
    generationPrompt: "Detailed political map of region. Cartographic style.",
    assetType: "image",
    sceneType: "map",
    visualDescription: "Map with borders",
    narration: "Narration 2",
    sceneGoal: "Reveal",
    cameraShot: "top-down",
    cameraMotion: "push-in",
    emphasis: "high",
    references: ["fact-001"],
  },
];

const VISUAL_PLAN = [
  {
    sceneId: 1,
    renderStyle: "photorealistic",
    colorMood: "cold blue",
    lighting: "soft diffused",
    composition: "rule-of-thirds",
  },
  {
    sceneId: 2,
    renderStyle: "map",
    colorMood: "cold blue",
    lighting: "flat top-down",
    composition: "centered",
  },
];

const SCENE_RESULTS = SCENES.map((s) => ({
  sceneId: s.sceneId,
  verdict: "pass" as const,
  feedback: "",
}));

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
  const promise = promptQANode(
    {
      project: { pillar: "Geography", topic: "Test" },
      production: { scenes: SCENES, visualPlan: VISUAL_PLAN },
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
  const promptTokens = overrides?.promptTokens ?? 8;
  const completionTokens = overrides?.completionTokens ?? 16;
  return {
    output:
      overrides?.content ??
      JSON.stringify({
        status: "approved",
        globalFeedback: "",
        sceneResults: SCENE_RESULTS,
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

describe("promptQANode", () => {
  it("returns approved for valid prompts", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.promptQA?.status).toBe("approved");
    expect(result.production?.promptQA?.sceneResults).toHaveLength(2);
    expect(result.production?.promptQA?.sceneResults![0].verdict).toBe("pass");
    expect(result.execution?.currentNode).toBe("PromptQA");
  });

  it("returns minor_revision with feedback", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        content: JSON.stringify({
          status: "minor_revision",
          globalFeedback: "Inconsistent color mood across scenes",
          sceneResults: [
            { sceneId: 1, verdict: "pass", feedback: "" },
            {
              sceneId: 2,
              verdict: "revise",
              feedback: "Missing map details from visualDescription",
            },
          ],
        }),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.promptQA?.status).toBe("minor_revision");
    expect(result.production?.promptQA?.globalFeedback).toContain("color mood");
    expect(result.production?.promptQA?.sceneResults![1].feedback).toContain(
      "map details",
    );
  });

  it("returns error when no scenes exist", async () => {
    const { promise } = runNode({ production: { scenes: [] } } as any);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("No scenes");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns error when generationPrompts are missing", async () => {
    const scenesNoPrompt = SCENES.map((s) => ({
      ...s,
      generationPrompt: undefined,
    }));
    const { promise } = runNode({
      production: { scenes: scenesNoPrompt },
    } as any);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("No scenes");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("signals retry (infra) on model failure", async () => {
    mockGenerate.mockRejectedValue(new Error("OpenRouter timeout"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.promptQA?.status).toBe("retry");
    expect(result.production?.promptQA?.globalFeedback).toContain(
      "OpenRouter timeout",
    );
  });

  it("routes missing sceneIds back as minor_revision", async () => {
    const partial = SCENE_RESULTS.slice(0, 1);
    mockGenerate.mockResolvedValue(
      buildResponse({
        content: JSON.stringify({
          status: "approved",
          globalFeedback: "",
          sceneResults: partial,
        }),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.promptQA?.status).toBe("minor_revision");
    expect(result.production?.promptQA?.globalFeedback).toContain(
      "Missing results",
    );
    expect(result.production?.promptQA?.globalFeedback).toContain("2");
    expect(result.production?.promptQA?.sceneResults).toHaveLength(1);
  });

  it("routes extra sceneIds back as minor_revision", async () => {
    const extra = [
      ...SCENE_RESULTS,
      { sceneId: 99, verdict: "pass" as const, feedback: "" },
    ];
    mockGenerate.mockResolvedValue(
      buildResponse({
        content: JSON.stringify({
          status: "approved",
          globalFeedback: "",
          sceneResults: extra,
        }),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.production?.promptQA?.status).toBe("minor_revision");
    expect(result.production?.promptQA?.globalFeedback).toContain(
      "Extra results",
    );
    expect(result.production?.promptQA?.globalFeedback).toContain("99");
  });

  it("loads prompt from expected path", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise, mocks } = runNode();
    await promise;

    expect(mocks.loadPrompt).toHaveBeenCalledWith("prompt-qa/v1.md");
  });

  it("telemetry records basic fields", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    const telemetry = result.diagnostics?.telemetry?.PromptQA;
    expect(telemetry).toBeDefined();
    expect(telemetry!.durationMs).toBeGreaterThanOrEqual(0);
    expect(telemetry!.model).toBe("test-model");
    expect(telemetry!.promptTokens).toBe(8);
    expect(telemetry!.completionTokens).toBe(16);
    expect(telemetry!.promptVersion).toBe("prompt-qa/v1");
    expect(telemetry!.agentVersion).toBe("1.0.0");
  });
});

function choice(value: string, confidence: number) {
  return {
    type: "choice" as const,
    choice: value,
    confidence,
    probabilities: { [value]: confidence },
  };
}

function makeClassifierFactory(answers: Record<string, unknown>) {
  return jest.fn(() => ({
    provider: "typesafe",
    model: "jev-test",
    classify: jest.fn().mockResolvedValue({
      answers,
      provider: "typesafe",
      model: "jev-test",
      usage: { inputTokens: 10, outputTokens: 0 },
      durationMs: 5,
    }),
  }));
}

function withClassifierEnv() {
  const prev = process.env.CLASSIFIER_PROVIDER;
  process.env.CLASSIFIER_PROVIDER = "typesafe";
  return () => {
    if (prev === undefined) delete process.env.CLASSIFIER_PROVIDER;
    else process.env.CLASSIFIER_PROVIDER = prev;
  };
}

function approvedAnswers() {
  return {
    status: choice("approved", 0.97),
    revision_target: choice("none", 0.95),
    scene_1: choice("pass", 0.96),
    scene_2: choice("pass", 0.94),
  };
}

describe("promptQANode classifier path", () => {
  it("trusted approved skips the LLM", async () => {
    const restore = withClassifierEnv();
    try {
      const createClassifier = makeClassifierFactory(approvedAnswers());
      const mocks = makeMocks();
      const result = await promptQANode(
        {
          project: { pillar: "Geography", topic: "Test" },
          production: { scenes: SCENES, visualPlan: VISUAL_PLAN },
          execution: { version: "0.1.0" },
        } as ProjectState,
        { configurable: { ...mocks, createClassifier } } as any,
      );

      expect(result.production?.promptQA?.status).toBe("approved");
      expect(result.production?.promptQA?.sceneResults).toHaveLength(2);
      expect(result.production?.promptQA?.revisionTarget).toBe("none");
      expect(mockGenerate).not.toHaveBeenCalled();
      expect(result.diagnostics?.telemetry?.PromptQA?.model).toBe(
        "typesafe/jev-test",
      );
    } finally {
      restore();
    }
  });

  it("trusted non-approved cascades to LLM and overrides status", async () => {
    const restore = withClassifierEnv();
    try {
      const answers = approvedAnswers();
      answers.status = choice("minor_revision", 0.91);
      answers.revision_target = choice("prompts", 0.9);
      answers.scene_2 = choice("revise", 0.88);
      const createClassifier = makeClassifierFactory(answers);
      mockGenerate.mockResolvedValue(buildResponse());
      const mocks = makeMocks();
      const result = await promptQANode(
        {
          project: { pillar: "Geography", topic: "Test" },
          production: { scenes: SCENES, visualPlan: VISUAL_PLAN },
          execution: { version: "0.1.0" },
        } as ProjectState,
        { configurable: { ...mocks, createClassifier } } as any,
      );

      expect(result.production?.promptQA?.status).toBe("minor_revision");
      expect(result.production?.promptQA?.revisionTarget).toBe("prompts");
      expect(
        result.production?.promptQA?.sceneResults.find((r) => r.sceneId === 2)
          ?.verdict,
      ).toBe("revise");
      expect(mockGenerate).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("low confidence abstains to the LLM path", async () => {
    const restore = withClassifierEnv();
    try {
      const answers = approvedAnswers();
      answers.status = choice("approved", 0.4);
      answers.revision_target = choice("none", 0.4);
      const createClassifier = makeClassifierFactory(answers);
      mockGenerate.mockResolvedValue(buildResponse());
      const mocks = makeMocks();
      const result = await promptQANode(
        {
          project: { pillar: "Geography", topic: "Test" },
          production: { scenes: SCENES, visualPlan: VISUAL_PLAN },
          execution: { version: "0.1.0" },
        } as ProjectState,
        { configurable: { ...mocks, createClassifier } } as any,
      );

      expect(result.production?.promptQA?.status).toBe("approved");
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      expect(result.diagnostics?.telemetry?.PromptQA?.model).toBe("test-model");
    } finally {
      restore();
    }
  });
});
