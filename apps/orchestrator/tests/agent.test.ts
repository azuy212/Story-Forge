import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { scriptPlannerNode } from "../src/agents/script-planner.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a content strategist.",
  "---",
  "Generate a title, hook, and story plan.",
  "",
  "Pillar: {{pillar}}",
  "Topic: {{topic}}",
  "ResearchSummary: {{researchSummary}}",
  "Facts: {{approvedFacts}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const FACTS = [
  {
    id: "fact-001",
    fact: "The nearest land is over 2,000 km away.",
    confidence: "medium",
  },
  {
    id: "fact-002",
    fact: "It has no permanent population.",
    confidence: "high",
  },
  {
    id: "fact-003",
    fact: "Its ecosystem is found nowhere else.",
    confidence: "high",
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
  const promise = scriptPlannerNode(
    {
      project: { pillar: "Geography", topic: "Unrecognized Countries" },
      research: { summary: "A remote island.", facts: FACTS },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: mocks } as any,
  );
  return { promise, mocks };
}

function storyBeats() {
  return Array.from({ length: 6 }, (_, i) => ({
    beatId: i + 1,
    purpose: `Purpose ${i + 1}`,
    viewerQuestion: `Question ${i + 1}?`,
    curiosityQuestion: `Next question ${i + 1}?`,
    keyMessage: `Message ${i + 1}.`,
    referencedFacts: [`fact-00${i + 1}`],
    priority: "high",
    estimatedDurationSeconds: i === 5 ? 10 : 8,
  }));
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
        content: {
          title: "The Country That Doesn't Exist",
          hook: "What if a country officially wasn't real?",
        },
        storyType: "mystery",
        storySummary:
          "A remote island that is one of the most isolated places on Earth.",
        storyBeats: storyBeats(),
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

describe("scriptPlannerNode", () => {
  it("returns title, hook, and story plan on successful generation", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.title).toBe("The Country That Doesn't Exist");
    expect(result.content?.hook).toBe(
      "What if a country officially wasn't real?",
    );
    expect(result.storyPlan?.storySummary).toBe(
      "A remote island that is one of the most isolated places on Earth.",
    );
    expect(result.storyPlan?.storyBeats).toHaveLength(6);
    expect(result.execution?.currentNode).toBe("ScriptPlanner");
    expect(result.diagnostics?.telemetry?.ScriptPlanner).toBeDefined();
    expect(result.diagnostics?.telemetry?.ScriptPlanner.retries).toBe(0);
    expect(result.diagnostics?.telemetry?.ScriptPlanner.model).toBe(
      "test-model",
    );
    expect(result.diagnostics?.telemetry?.ScriptPlanner.totalTokens).toBe(45);
    expect(result.diagnostics?.errors).toBeUndefined();
  });

  it("passes pillar, topic, and research facts to the model", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    await promise;

    const calls = mockGenerate.mock.calls;
    const messages = calls[0][0] as { role: string; content: string }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("Geography");
    expect(userMsg!.content).toContain("Unrecognized Countries");
    expect(userMsg!.content).toContain("fact-001");
    expect(userMsg!.content).toContain("A remote island.");
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

    expect(result.content?.title).toBe("The Country That Doesn't Exist");
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ScriptPlanner.retries).toBe(1);
  });

  it("retries once after schema validation failure", async () => {
    const badJson = JSON.stringify({ content: { wrongField: "abc" } });
    mockGenerate
      .mockResolvedValueOnce(buildResponse({ content: badJson }))
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.title).toBe("The Country That Doesn't Exist");
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ScriptPlanner.retries).toBe(1);
  });

  it("returns empty output and writes error after all attempts fail", async () => {
    mockGenerate.mockResolvedValue(buildResponse({ content: "bad json" }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.title).toBeUndefined();
    expect(result.storyPlan?.storyBeats).toEqual([]);
    expect(mockGenerate).toHaveBeenCalledTimes(3);
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors!.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics?.errors![0]).toContain("ScriptPlanner");
    expect(result.diagnostics?.telemetry?.ScriptPlanner.retries).toBe(3);
  });

  it("rejects non-contiguous beatIds as a schema failure", async () => {
    // beatId must be 1-based sequential: a skipped ID breaks the structural
    // contract consumed by downstream agents, so it is a hard schema error.
    const beats = storyBeats().map((b, i) =>
      i === 3 ? { ...b, beatId: 9 } : b,
    );
    mockGenerate.mockResolvedValue(
      buildResponse({
        content: JSON.stringify({
          content: { title: "T", hook: "H?" },
          storyType: "mystery",
          storySummary: "S.",
          storyBeats: beats,
        }),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.storyPlan?.storyBeats).toEqual([]);
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "beatId must be sequential",
    );
    expect(result.diagnostics?.telemetry?.ScriptPlanner.retries).toBe(3);
  });

  it("warns when a beat references an unknown fact", async () => {
    const beats = storyBeats().map((b, i) =>
      i === 0 ? { ...b, referencedFacts: ["fact-999"] } : b,
    );
    mockGenerate.mockResolvedValue(
      buildResponse({
        content: JSON.stringify({
          content: { title: "T", hook: "H?" },
          storyType: "mystery",
          storySummary: "S.",
          storyBeats: beats,
        }),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(
      result.diagnostics?.warnings!.some((w) => w.includes("fact-999")),
    ).toBe(true);
  });

  it("accepts an ending-hook curiosityQuestion on the final beat without warnings", async () => {
    const beats = storyBeats().map((b, i) => ({
      ...b,
      curiosityQuestion:
        i === 5
          ? "And the deeper mystery remains: researchers still can't explain how it got that way."
          : b.curiosityQuestion,
    }));
    mockGenerate.mockResolvedValue(
      buildResponse({
        content: JSON.stringify({
          content: { title: "T", hook: "H?" },
          storyType: "mystery",
          storySummary: "S.",
          storyBeats: beats,
        }),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.errors ?? []).toHaveLength(0);
    expect(
      result.diagnostics?.warnings?.some((w) =>
        w.includes("curiosityQuestion"),
      ) ?? false,
    ).toBe(false);
  });

  it("rejects a null curiosityQuestion on any beat as a schema failure", async () => {
    const beats = storyBeats().map((b, i) => ({
      ...b,
      curiosityQuestion: i === 2 ? null : b.curiosityQuestion,
    }));
    mockGenerate.mockResolvedValue(
      buildResponse({
        content: JSON.stringify({
          content: { title: "T", hook: "H?" },
          storyType: "mystery",
          storySummary: "S.",
          storyBeats: beats,
        }),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.storyPlan?.storyBeats).toEqual([]);
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "expected string, received null",
    );
    expect(result.diagnostics?.telemetry?.ScriptPlanner.retries).toBe(3);
  });

  it("requires research before planning", async () => {
    const { promise } = runNode({ research: { summary: "", facts: [] } });
    const result = await promise;

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("ScriptPlanner");
  });

  it("loads prompt from expected path", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise, mocks } = runNode();
    await promise;

    expect(mocks.loadPrompt).toHaveBeenCalledWith("script-planner/v1.md");
  });
});
