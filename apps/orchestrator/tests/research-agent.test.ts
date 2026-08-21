import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { researchAgentNode } from "../src/agents/research-agent.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a research assistant.",
  "---",
  "Generate research for a Short.",
  "",
  "Pillar: {{pillar}}",
  "Topic: {{topic}}",
  "QA Feedback: {{qaFeedback}}",
  "Previous Research: {{previousResearch}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const BASE_FACTS = [
  {
    id: "fact-001",
    fact: "This is a factual statement about the topic.",
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-002",
    fact: "Another factual statement with supporting details.",
    confidence: "medium" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-003",
    fact: "A third important fact about the subject matter.",
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-004",
    fact: "Here is a fourth fact with more specific detail.",
    confidence: "low" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-005",
    fact: "The fifth fact provides additional context for understanding.",
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-006",
    fact: "Sixth fact covering an important aspect of the topic.",
    confidence: "medium" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-007",
    fact: "Seventh fact that supports the overall narrative.",
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-008",
    fact: "Eighth fact rounding out the key information needed.",
    confidence: "medium" as const,
    sourceType: "general-knowledge" as const,
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
  const promise = researchAgentNode(
    {
      project: { pillar: "Geography", topic: "Unrecognized Countries" },
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
  const promptTokens = overrides?.promptTokens ?? 12;
  const completionTokens = overrides?.completionTokens ?? 40;
  return {
    output:
      overrides?.content ??
      JSON.stringify({
        summary: "This is a summary of the research findings about the topic.",
        facts: BASE_FACTS,
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

describe("researchAgentNode", () => {
  it("returns summary and facts on success", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.research?.summary).toBe(
      "This is a summary of the research findings about the topic.",
    );
    expect(result.research?.facts).toHaveLength(8);
    expect(result.research?.facts![0].id).toBe("fact-001");
    expect(result.research?.facts![0].confidence).toBe("high");
    expect(result.research?.facts![0].sourceType).toBe("general-knowledge");
    expect(result.execution?.currentNode).toBe("ResearchAgent");
    expect(result.diagnostics?.telemetry?.ResearchAgent).toBeDefined();
    expect(result.diagnostics?.errors).toBeUndefined();
  });

  it("passes pillar and topic to the model", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    await promise;

    const calls = mockGenerate.mock.calls;
    const messages = calls[0][0] as { role: string; content: string }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("Geography");
    expect(userMsg!.content).toContain("Unrecognized Countries");
  });

  it("attaches the previous research on minor_revision", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode({
      research: {
        summary: "OLD RESEARCH SUMMARY distinctive draft.",
        facts: [
          {
            id: "fact-001",
            fact: "OLD FACT CONTENT that must be carried into the revision.",
            confidence: "high",
            sourceType: "general-knowledge",
          },
        ],
      },
      researchQA: {
        status: "minor_revision",
        feedback: "Fix fact-001.",
        issues: ["fact-001 unsupported"],
        factsToRegenerate: 1,
        factVerdicts: [],
      },
    });
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain(
      "OLD RESEARCH SUMMARY distinctive draft.",
    );
    expect(userMsg!.content).toContain("OLD FACT CONTENT");
    expect(userMsg!.content).toContain("fact-001");
  });

  it("does not attach previous research on a fresh run", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    await promise;

    const messages = mockGenerate.mock.calls[0][0] as {
      role: string;
      content: string;
    }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).not.toContain("OLD RESEARCH SUMMARY");
  });

  it("trims fact text and summary on success", async () => {
    const content = JSON.stringify({
      summary: "  Summary with whitespace.  ",
      facts: [
        {
          id: "fact-001",
          fact: "  Fact with padding.  ",
          confidence: "high",
          sourceType: "general-knowledge",
        },
        {
          id: "fact-002",
          fact: "  Another padded fact.  ",
          confidence: "medium",
          sourceType: "general-knowledge",
        },
        {
          id: "fact-003",
          fact: "Third fact.",
          confidence: "high",
          sourceType: "general-knowledge",
        },
        {
          id: "fact-004",
          fact: "Fourth fact.",
          confidence: "low",
          sourceType: "general-knowledge",
        },
        {
          id: "fact-005",
          fact: "Fifth fact.",
          confidence: "high",
          sourceType: "general-knowledge",
        },
        {
          id: "fact-006",
          fact: "Sixth fact.",
          confidence: "medium",
          sourceType: "general-knowledge",
        },
        {
          id: "fact-007",
          fact: "Seventh fact.",
          confidence: "high",
          sourceType: "general-knowledge",
        },
        {
          id: "fact-008",
          fact: "Eighth fact.",
          confidence: "medium",
          sourceType: "general-knowledge",
        },
      ],
    });
    mockGenerate.mockResolvedValue(buildResponse({ content }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.research?.summary).toBe("Summary with whitespace.");
    expect(result.research?.facts![0].fact).toBe("Fact with padding.");
  });

  it("retries once after invalid JSON, succeeds on second attempt", async () => {
    mockGenerate
      .mockResolvedValueOnce(buildResponse({ content: "not json" }))
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.research?.summary).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ResearchAgent.retries).toBe(1);
  });

  it("retries once after schema validation failure", async () => {
    mockGenerate
      .mockResolvedValueOnce(
        buildResponse({ content: JSON.stringify({ summary: "", facts: [] }) }),
      )
      .mockResolvedValueOnce(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.research?.summary).toBeDefined();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("returns error when summary has too few facts", async () => {
    const fewFacts = JSON.stringify({
      summary: "A short summary.",
      facts: [
        {
          id: "fact-001",
          fact: "One fact.",
          confidence: "high",
          sourceType: "general-knowledge",
        },
      ],
    });
    mockGenerate.mockResolvedValue(buildResponse({ content: fewFacts }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors!.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics?.errors![0]).toContain("ResearchAgent");
  });

  it("returns error for empty summary", async () => {
    const emptySummary = JSON.stringify({
      summary: "",
      facts: BASE_FACTS,
    });
    mockGenerate.mockResolvedValue(buildResponse({ content: emptySummary }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("ResearchAgent");
  });

  it("clears research on failure so stale output cannot pass the guard", async () => {
    mockGenerate.mockResolvedValue(buildResponse({ content: "bad json" }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.research).toEqual({ summary: "", facts: [] });
    expect(result.diagnostics?.errors![0]).toContain("ResearchAgent");
  });

  it("handles rejected promise from model", async () => {
    mockGenerate.mockRejectedValue(new Error("OpenRouter timeout"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.research).toEqual({ summary: "", facts: [] });
    expect(result.diagnostics?.errors![0]).toContain("OpenRouter timeout");
  });

  it("telemetry records promptVersion and agentVersion", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    const telemetry = result.diagnostics?.telemetry?.ResearchAgent;
    expect(telemetry).toBeDefined();
    expect(telemetry!.durationMs).toBeGreaterThanOrEqual(0);
    expect(telemetry!.promptVersion).toBe("research-agent/v1");
    expect(telemetry!.agentVersion).toBe("1.0.0");
  });

  it("passes verified flags and reasons through to research state", async () => {
    const content = JSON.stringify({
      summary: "Verified summary.",
      facts: BASE_FACTS.map((f) => ({
        ...f,
        verified: true,
        reason: `Why ${f.id} is accepted.`,
      })),
    });
    mockGenerate.mockResolvedValue(buildResponse({ content }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.research?.facts).toHaveLength(8);
    expect(result.research?.facts![0].verified).toBe(true);
    expect(result.research?.facts![0].reason).toBe("Why fact-001 is accepted.");
    expect(result.research?.facts![7].verified).toBe(true);
  });

  it("loads prompt from expected path", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise, mocks } = runNode();
    await promise;

    expect(mocks.loadPrompt).toHaveBeenCalledWith("research-agent/v1.md");
  });
});
