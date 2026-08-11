import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { scriptWriterNode } from "../src/agents/script-writer.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a script writer.",
  "---",
  "Title: {{title}}",
  "Hook: {{hook}}",
  "Research Summary: {{researchSummary}}",
  "Research Facts:",
  "{{researchFacts}}",
  "Story Summary: {{storySummary}}",
  "Story Beats: {{storyBeats}}",
  "Channel: {{channel}}",
  "Call to Action: {{cta}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const BASE_RESEARCH = {
  summary:
    "A remote island in the Pacific Ocean that is one of the most isolated places on Earth.",
  facts: [
    {
      id: "fact-001",
      fact: "It is one of the most isolated places on Earth.",
      confidence: "high",
      sourceType: "general-knowledge" as const,
    },
    {
      id: "fact-002",
      fact: "The nearest landmass is over 2,000 km away.",
      confidence: "medium",
      sourceType: "general-knowledge" as const,
    },
    {
      id: "fact-003",
      fact: "It has no permanent population.",
      confidence: "high",
      sourceType: "general-knowledge" as const,
    },
    {
      id: "fact-004",
      fact: "It was discovered in the 18th century.",
      confidence: "low",
      sourceType: "general-knowledge" as const,
    },
    {
      id: "fact-005",
      fact: "Its ecosystem is highly unique.",
      confidence: "high",
      sourceType: "general-knowledge" as const,
    },
    {
      id: "fact-006",
      fact: "It is protected as a nature reserve.",
      confidence: "medium",
      sourceType: "general-knowledge" as const,
    },
    {
      id: "fact-007",
      fact: "Access requires special permission.",
      confidence: "high",
      sourceType: "general-knowledge" as const,
    },
    {
      id: "fact-008",
      fact: "It appears on very few maps.",
      confidence: "medium",
      sourceType: "general-knowledge" as const,
    },
  ],
};

const BASE_STORY_PLAN = {
  storySummary: "A remote island that is the most isolated place on Earth.",
  storyBeats: [
    {
      beatId: 1,
      purpose: "Hook with central question",
      viewerQuestion: "What if a country wasn't real?",
      keyMessage: "This place defies normal geography.",
      referencedFacts: ["fact-001"],
      priority: "high",
      estimatedDurationSeconds: 4,
    },
    {
      beatId: 2,
      purpose: "Reveal geographical fact",
      viewerQuestion: "Where is it?",
      keyMessage: "The nearest land is over 2,000 km away.",
      referencedFacts: ["fact-001", "fact-002"],
      priority: "high",
      estimatedDurationSeconds: 7,
    },
    {
      beatId: 3,
      purpose: "Show scale of isolation",
      viewerQuestion: "How remote is it really?",
      keyMessage: "One of the most isolated places on the planet.",
      referencedFacts: ["fact-002"],
      priority: "medium",
      estimatedDurationSeconds: 8,
    },
    {
      beatId: 4,
      purpose: "Reveal population fact",
      viewerQuestion: "Does anyone live there?",
      keyMessage: "It has no permanent population.",
      referencedFacts: ["fact-003"],
      priority: "medium",
      estimatedDurationSeconds: 8,
    },
    {
      beatId: 5,
      purpose: "Highlight ecological significance",
      viewerQuestion: "Why does it matter?",
      keyMessage: "Its ecosystem is found nowhere else.",
      referencedFacts: ["fact-005"],
      priority: "medium",
      estimatedDurationSeconds: 8,
    },
    {
      beatId: 6,
      purpose: "Deliver final payoff",
      viewerQuestion: "Can I visit?",
      keyMessage: "Access requires special permission.",
      referencedFacts: ["fact-007"],
      priority: "high",
      estimatedDurationSeconds: 7,
    },
  ],
};

const BASE_BRANDING = { channel: "GeoFacts", creator: "", cta: "Subscribe" };

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
  const promise = scriptWriterNode(
    {
      project: { pillar: "Geography", topic: "Unrecognized Countries" },
      content: {
        title: "The Country That Doesn't Exist",
        hook: "What if a country officially wasn't real?",
      },
      research: BASE_RESEARCH,
      storyPlan: BASE_STORY_PLAN,
      branding: BASE_BRANDING,
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
    choices: [
      {
        message: {
          content:
            overrides?.content ??
            JSON.stringify({
              content: {
                script:
                  "[What if a country officially wasn't real?] The nation has no borders...",
                narration:
                  "What if a country officially wasn't real? The nation has no borders...",
                callToAction: "Follow @UniverseDecoded for more.",
                estimatedDurationSeconds: 42,
                ending: {
                  type: "open_question",
                  narration: "The nation has no borders...",
                  visualDirection: "Hold on the empty map.",
                },
              },
            }),
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    model: "test-model",
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("scriptWriterNode", () => {
  it("returns script, narration, CTA, and duration on success", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.script).toContain(
      "What if a country officially wasn't real?",
    );
    expect(result.content?.narration).toContain(
      "What if a country officially wasn't real?",
    );
    expect(result.content?.callToAction).toBe("Subscribe");
    expect(result.content?.ending?.type).toBe("open_question");
    expect(result.content?.estimatedDurationSeconds).toBe(42);
    expect(result.execution?.currentNode).toBe("ScriptWriter");
    expect(result.diagnostics?.telemetry?.ScriptWriter).toBeDefined();
    expect(result.diagnostics?.telemetry?.ScriptWriter.retries).toBe(0);
    expect(result.diagnostics?.telemetry?.ScriptWriter.model).toBe(
      "test-model",
    );
    expect(result.diagnostics?.errors).toBeUndefined();
  });

  it("passes title, hook, research, story plan, and branding to model", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    await promise;

    const calls = mockGenerate.mock.calls;
    const messages = calls[0][0] as { role: string; content: string }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("The Country That Doesn't Exist");
    expect(userMsg!.content).toContain(
      "What if a country officially wasn't real?",
    );
    expect(userMsg!.content).toContain("A remote island in the Pacific Ocean");
    expect(userMsg!.content).toContain("fact-001");
    expect(userMsg!.content).toContain("Confidence: high");
    expect(userMsg!.content).toContain(
      "It is one of the most isolated places on Earth.",
    );
    expect(userMsg!.content).toContain("Hook with central question");
    expect(userMsg!.content).toContain("Beat 1");
    expect(userMsg!.content).toContain("GeoFacts");
    expect(userMsg!.content).toContain("Subscribe");
  });

  it("uses configured CTA instead of model CTA", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.callToAction).toBe("Subscribe");
    expect(result.content?.callToAction).not.toBe(
      "Follow @UniverseDecoded for more.",
    );
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

    expect(result.content?.script).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ScriptWriter.retries).toBe(1);
  });

  it("retries once after schema validation failure", async () => {
    const badJson = JSON.stringify({ content: { wrongField: "abc" } });
    mockGenerate
      .mockResolvedValueOnce(buildResponse({ content: badJson }))
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.script).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ScriptWriter.retries).toBe(1);
  });

  it("returns empty content and writes error after all attempts fail", async () => {
    mockGenerate.mockResolvedValue(buildResponse({ content: "bad json" }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.script).toBe("");
    expect(result.content?.narration).toBe("");
    expect(mockGenerate).toHaveBeenCalledTimes(3);
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors!.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics?.errors![0]).toContain("ScriptWriter");
    expect(result.diagnostics?.telemetry?.ScriptWriter.retries).toBe(3);
  });

  it("handles empty fields from LLM", async () => {
    const emptyJson = JSON.stringify({
      content: {
        script: "",
        narration: "valid",
        callToAction: "valid",
        estimatedDurationSeconds: 30,
      },
    });
    mockGenerate
      .mockResolvedValueOnce(buildResponse({ content: emptyJson }))
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.script).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("handles model throwing an error", async () => {
    mockGenerate.mockRejectedValue(new Error("OpenRouter timeout"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.script).toBe("");
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("OpenRouter timeout");
    expect(mockGenerate).toHaveBeenCalledTimes(3);
  });

  it("handles empty response (no content in message)", async () => {
    mockGenerate.mockResolvedValue({
      choices: [{ message: { content: null } }],
      usage: {},
      model: "test-model",
    });

    const { promise } = runNode();
    const result = await promise;

    expect(result.content?.script).toBe("");
    expect(result.diagnostics?.errors).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(3);
  });

  it("telemetry records duration, tokens, promptVersion, agentVersion", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    const telemetry = result.diagnostics?.telemetry?.ScriptWriter;
    expect(telemetry).toBeDefined();
    expect(telemetry!.durationMs).toBeGreaterThanOrEqual(0);
    expect(telemetry!.model).toBe("test-model");
    expect(telemetry!.promptTokens).toBe(15);
    expect(telemetry!.completionTokens).toBe(30);
    expect(telemetry!.promptVersion).toBe("script-writer/v1");
    expect(telemetry!.agentVersion).toBe("1.0.0");
  });

  it("loads prompt from expected path", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise, mocks } = runNode();
    await promise;

    expect(mocks.loadPrompt).toHaveBeenCalledWith("script-writer/v1.md");
  });

  it("returns error when research is missing", async () => {
    const { promise } = runNode({ research: {} } as any);
    const result = await promise;

    expect(result.content?.script).toBe("");
    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("research is required");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns error when research has no summary and no facts", async () => {
    const { promise } = runNode({
      research: { summary: "", facts: [] },
    } as any);
    const result = await promise;

    expect(result.content?.script).toBe("");
    expect(result.diagnostics?.errors![0]).toContain("research is required");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns error when story plan is missing", async () => {
    const { promise } = runNode({
      storyPlan: { storySummary: "", storyBeats: [] },
    } as any);
    const result = await promise;

    expect(result.content?.script).toBe("");
    expect(result.diagnostics?.errors![0]).toContain("story plan");
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
