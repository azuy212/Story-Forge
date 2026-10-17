import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
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
        factsToRegenerateIds: ["fact-001"],
        factVerdicts: verdicts,
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.researchQA?.status).toBe("minor_revision");
    expect(result.researchQA?.factsToRegenerate).toBe(1);
    // Every other verdict is "keep": only the flagged fact ID is targeted.
    expect(result.researchQA?.factsToRegenerateIds).toEqual(["fact-001"]);
    expect(result.research).toEqual({});
    // The reviewed artifact hash is persisted for the non-convergence guard.
    expect(result.execution?.qaArtifactHash?.ResearchQA).toBeDefined();
    expect(result.researchQA?.artifactUnchanged).toBeUndefined();
  });

  it("flags unchanged artifacts on a revision over the same research", async () => {
    const revision = (note: string) => {
      const verdicts = FACTS.map((f) => ({
        factId: f.id,
        verdict: "keep",
        reason: "ok",
      }));
      verdicts[0] = {
        factId: "fact-001",
        verdict: "revise",
        reason: note,
      };
      return {
        status: "minor_revision",
        feedback: note,
        issues: [`fact-001: ${note}`],
        factsToRegenerate: 1,
        factsToRegenerateIds: ["fact-001"],
        factVerdicts: verdicts,
      };
    };

    // Round 1: revision over fresh research → no flag, hash persisted.
    mockGenerate.mockResolvedValueOnce(
      buildResponse(revision("Needs correction")),
    );
    const first = await runNode().promise;
    const persistedHash = first.execution?.qaArtifactHash?.ResearchQA;
    expect(persistedHash).toBeDefined();

    // Round 2: identical research, differently-worded feedback → same hash,
    // flag set so the router can stop the non-converging loop early.
    mockGenerate.mockResolvedValueOnce(
      buildResponse(revision("Needs correction tightened")),
    );
    const second = await runNode({
      execution: {
        version: "0.1.0",
        retryCount: { ResearchQA: 1 },
        qaArtifactHash: { ResearchQA: persistedHash! },
      },
    } as Partial<ProjectState>).promise;
    expect(second.researchQA?.status).toBe("minor_revision");
    expect(second.researchQA?.artifactUnchanged).toBe(true);
    expect(second.execution?.qaArtifactHash?.ResearchQA).toBe(persistedHash);
  });

  it("does not flag unchanged when the research actually changed", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildResponse({
        status: "minor_revision",
        feedback: "Fix it.",
        issues: ["fact-001: wrong"],
        factsToRegenerate: 0,
        factVerdicts: FACTS.map((f) => ({
          factId: f.id,
          verdict: "keep",
          reason: "ok",
        })),
      }),
    );
    const result = await runNode({
      execution: {
        version: "0.1.0",
        qaArtifactHash: { ResearchQA: "different-previous-hash" },
      },
    } as Partial<ProjectState>).promise;
    expect(result.researchQA?.artifactUnchanged).toBeUndefined();
  });

  it("approves accurate research with a no-trigger note (advisory arc path)", async () => {
    // The dead-leaf loop the earlier prompt revision targeted: accurate
    // research must come back approved, with the trigger gap as feedback
    // only — never a revision status for the model to act on.
    mockGenerate.mockResolvedValueOnce(
      buildResponse({
        status: "approved",
        feedback:
          "Facts are accurate. Trigger material absent: planner should use a documentary-explanation arc.",
        issues: [],
        factsToRegenerate: 0,
        factVerdicts: approvedResponse().factVerdicts,
      }),
    );
    const result = await runNode().promise;
    expect(result.researchQA?.status).toBe("approved");
    // No regeneration targets: nothing was flagged.
    expect(result.researchQA?.factsToRegenerateIds).toBeUndefined();
    expect(result.research?.facts?.[0].verified).toBe(true);
  });

  it("returns fail when no facts collected", async () => {
    const { promise } = runNode({ research: { facts: [] } } as any);
    const result = await promise;

    expect(result.researchQA?.status).toBe("fail");
    expect(result.researchQA?.issues).toContain("No facts collected");
    expect(result.diagnostics?.errors).toBeDefined();
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

const CLASSIFIER_ENV_KEYS = ["CLASSIFIER_PROVIDER"] as const;
let savedClassifierEnv: Record<string, string | undefined> = {};

function withClassifierEnv() {
  savedClassifierEnv = {};
  for (const key of CLASSIFIER_ENV_KEYS) {
    savedClassifierEnv[key] = process.env[key];
  }
  process.env.CLASSIFIER_PROVIDER = "typesafe";
}

function restoreClassifierEnv() {
  for (const key of CLASSIFIER_ENV_KEYS) {
    if (savedClassifierEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedClassifierEnv[key]!;
  }
}

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

function researchApprovedAnswers() {
  const answers: Record<string, unknown> = {
    status: choice("approved", 0.97),
  };
  for (const f of FACTS) {
    answers[`fact_${f.id}`] = choice("keep", 0.95);
  }
  return answers;
}

describe("researchQANode classifier path", () => {
  beforeEach(() => {
    withClassifierEnv();
  });

  afterEach(() => {
    restoreClassifierEnv();
  });

  it("trusted approved skips the LLM and verifies facts", async () => {
    const createClassifier = makeClassifierFactory(researchApprovedAnswers());
    const mocks = makeMocks();
    const result = await researchQANode(
      {
        project: { pillar: "Geography", topic: "Unrecognized Countries" },
        research: { summary: "A summary.", facts: FACTS },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: { ...mocks, createClassifier } } as any,
    );

    expect(result.researchQA?.status).toBe("approved");
    expect(result.research?.facts![0].verified).toBe(true);
    expect(result.research?.facts![0].reason).toBe("Classifier verdict");
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(createClassifier).toHaveBeenCalled();
    expect(result.diagnostics?.telemetry?.ResearchQA?.model).toBe(
      "typesafe/jev-test",
    );
  });

  it("trusted non-approved cascades to LLM and overrides status", async () => {
    const answers = researchApprovedAnswers();
    answers.status = choice("minor_revision", 0.92);
    const createClassifier = makeClassifierFactory(answers);
    mockGenerate.mockResolvedValueOnce(
      buildResponse({
        status: "approved",
        feedback: "",
        issues: [],
        factsToRegenerate: 0,
        factVerdicts: FACTS.map((f) => ({
          factId: f.id,
          verdict: "keep",
          reason: "ok",
        })),
      }),
    );

    const mocks = makeMocks();
    const result = await researchQANode(
      {
        project: { pillar: "Geography", topic: "Unrecognized Countries" },
        research: { summary: "A summary.", facts: FACTS },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: { ...mocks, createClassifier } } as any,
    );

    expect(result.researchQA?.status).toBe("minor_revision");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result.research).toEqual({});
  });

  it("low confidence abstains to the LLM path", async () => {
    const answers = researchApprovedAnswers();
    answers.status = choice("approved", 0.4);
    const createClassifier = makeClassifierFactory(answers);
    mockGenerate.mockResolvedValueOnce(buildResponse(approvedResponse()));

    const mocks = makeMocks();
    const result = await researchQANode(
      {
        project: { pillar: "Geography", topic: "Unrecognized Countries" },
        research: { summary: "A summary.", facts: FACTS },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: { ...mocks, createClassifier } } as any,
    );

    expect(result.researchQA?.status).toBe("approved");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result.research?.facts![0].reason).toContain("Accepted:");
  });
});
