import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { researchQANode } from "../src/agents/research-qa.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a research QA reviewer.",
  "---",
  "Verify research for a Short.",
  "Pillar: {{pillar}}",
  "Topic: {{topic}}",
  "Facts:\n{{facts}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const FACTS = [
  {
    id: "fact-001",
    fact: "Fact one.",
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-002",
    fact: "Fact two.",
    confidence: "medium" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-003",
    fact: "Fact three.",
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-004",
    fact: "Fact four.",
    confidence: "low" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-005",
    fact: "Fact five.",
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-006",
    fact: "Fact six.",
    confidence: "medium" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-007",
    fact: "Fact seven.",
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  },
  {
    id: "fact-008",
    fact: "Fact eight.",
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
  const promise = researchQANode(
    {
      project: { pillar: "Geography", topic: "Unrecognized Countries" },
      research: { summary: "A summary.", facts: FACTS },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: mocks } as any,
  );
  return { promise, mocks };
}

function buildResponse(data: unknown) {
  return {
    output: JSON.stringify(data),
    usage: { promptTokens: 12, completionTokens: 20, totalTokens: 32 },
  };
}

function approvedResponse() {
  return {
    status: "approved",
    feedback: "",
    issues: [],
    factsToRegenerate: 0,
    factVerdicts: FACTS.map((f) => ({
      factId: f.id,
      verdict: "keep",
      reason: `Accepted: ${f.fact}`,
    })),
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("researchQANode", () => {
  it("approves and merges verified reasons into research facts", async () => {
    mockGenerate.mockResolvedValueOnce(buildResponse(approvedResponse()));

    const { promise } = runNode();
    const result = await promise;

    expect(result.researchQA?.status).toBe("approved");
    expect(result.research?.facts).toHaveLength(8);
    expect(result.research?.facts![0].verified).toBe(true);
    expect(result.research?.facts![0].reason).toContain("Accepted:");
    expect(result.execution?.currentNode).toBe("ResearchQA");
    expect(result.diagnostics?.telemetry?.ResearchQA).toBeDefined();
  });

  it("merges only keep verdicts as verified", async () => {
    const verdicts = FACTS.map((f, i) => ({
      factId: f.id,
      verdict: i === 3 ? "remove" : "keep",
      reason: i === 3 ? "Unsupported claim" : `Accepted: ${f.fact}`,
    }));
    mockGenerate.mockResolvedValueOnce(
      buildResponse({
        status: "approved",
        feedback: "",
        issues: [],
        factsToRegenerate: 1,
        factVerdicts: verdicts,
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.research?.facts![3].verified).toBeUndefined();
    expect(result.research?.facts![0].verified).toBe(true);
  });

  it("merges classification from keep verdicts into research facts", async () => {
    const verdicts = FACTS.map((f) => ({
      factId: f.id,
      verdict: "keep" as const,
      reason: `Accepted: ${f.fact}`,
      classification: f.id === "fact-002" ? ("debated" as const) : undefined,
    }));
    mockGenerate.mockResolvedValueOnce(
      buildResponse({
        status: "approved",
        feedback: "",
        issues: [],
        factsToRegenerate: 0,
        factVerdicts: verdicts,
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.research?.facts![1].classification).toBe("debated");
    expect(result.research?.facts![0].classification).toBeUndefined();
  });

  it("returns minor_revision without modifying research", async () => {
    const verdicts = FACTS.map((f) => ({
      factId: f.id,
      verdict: "keep",
      reason: "ok",
    }));
    verdicts[0] = {
      factId: "fact-001",
      verdict: "revise",
      reason: "Needs correction",
    };
    mockGenerate.mockResolvedValueOnce(
      buildResponse({
        status: "minor_revision",
        feedback: "Correct fact-001.",
        issues: ["fact-001: needs correction"],
        factsToRegenerate: 1,
        factVerdicts: verdicts,
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.researchQA?.status).toBe("minor_revision");
    expect(result.researchQA?.factsToRegenerate).toBe(1);
    expect(result.research).toEqual({});
  });

  it("returns minor_revision when no facts collected", async () => {
    const { promise } = runNode({ research: { facts: [] } } as any);
    const result = await promise;

    expect(result.researchQA?.status).toBe("minor_revision");
    expect(result.researchQA?.issues).toContain("No facts collected");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("signals retry (infra) on LLM failure", async () => {
    mockGenerate.mockRejectedValue(new Error("API timeout"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.researchQA?.status).toBe("retry");
    expect(result.researchQA?.issues![0]).toContain("API timeout");
  });

  it("passes facts to the model", async () => {
    mockGenerate.mockResolvedValueOnce(buildResponse(approvedResponse()));

    const { promise } = runNode();
    await promise;

    const calls = mockGenerate.mock.calls;
    const messages = calls[0][0] as { role: string; content: string }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("fact-001");
    expect(userMsg!.content).toContain("Fact one.");
  });

  it("skips when disabled", async () => {
    const prev = process.env.ENABLE_RESEARCH_QA;
    const prevAll = process.env.ENABLE_QA;
    process.env.ENABLE_RESEARCH_QA = "false";
    process.env.ENABLE_QA = "false";
    try {
      const { promise } = runNode();
      const result = await promise;
      expect(result.researchQA?.status).toBe("approved");
      expect(mockGenerate).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ENABLE_RESEARCH_QA;
      else process.env.ENABLE_RESEARCH_QA = prev;
      if (prevAll === undefined) delete process.env.ENABLE_QA;
      else process.env.ENABLE_QA = prevAll;
    }
  });

  it("loads prompt from expected path", async () => {
    mockGenerate.mockResolvedValueOnce(buildResponse(approvedResponse()));

    const { promise, mocks } = runNode();
    await promise;

    expect(mocks.loadPrompt).toHaveBeenCalledWith("research-qa/v1.md");
  });
});
