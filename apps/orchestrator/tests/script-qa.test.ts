import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { scriptQANode } from "../src/agents/script-qa.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a script QA reviewer.",
  "---",
  "Script: {{script}}",
  "Narration: {{narration}}",
  "CTA: {{cta}}",
  "Duration: {{estimatedDurationSeconds}}",
  "Facts: {{researchFacts}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

const BASE_CONTENT = {
  script:
    "[What if a country officially wasn't real?] The nation has no borders...",
  narration:
    "What if a country officially wasn't real? The nation has no borders... It is one of the most isolated places. No one lives here permanently. Its ecosystem is highly unique. Access requires special permission. Follow @UniverseDecoded for more.",
  callToAction: "Follow @UniverseDecoded for more.",
  estimatedDurationSeconds: 42,
};

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
  const promise = scriptQANode(
    {
      project: { pillar: "Geography", topic: "Unrecognized Countries" },
      content: BASE_CONTENT,
      research: {
        summary: "A remote island.",
        facts: [
          {
            id: "fact-001",
            fact: "It is one of the most isolated places on Earth.",
            confidence: "high" as const,
            sourceType: "general-knowledge" as const,
          },
          {
            id: "fact-002",
            fact: "The nearest landmass is over 2,000 km away.",
            confidence: "medium" as const,
            sourceType: "general-knowledge" as const,
          },
        ],
      },
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
            JSON.stringify({ status: "approved", feedback: "" }),
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

describe("scriptQANode", () => {
  it("returns approved for valid script", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    expect(result.scriptQA?.status).toBe("approved");
    expect(result.execution?.currentNode).toBe("ScriptQA");
    expect(result.diagnostics?.telemetry?.ScriptQA).toBeDefined();
  });

  it("returns minor_revision with feedback for invalid script", async () => {
    mockGenerate.mockResolvedValue(
      buildResponse({
        content: JSON.stringify({
          status: "minor_revision",
          feedback:
            "Factual accuracy: claim about visibility from space not in research.",
        }),
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.scriptQA?.status).toBe("minor_revision");
    expect(result.scriptQA?.feedback).toContain("Factual accuracy");
  });

  it("passes script, narration, and research facts to model", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    await promise;

    const calls = mockGenerate.mock.calls;
    const messages = calls[0][0] as { role: string; content: string }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain(
      "What if a country officially wasn't real?",
    );
    expect(userMsg!.content).toContain(
      "It is one of the most isolated places on Earth.",
    );
    expect(userMsg!.content).toContain("fact-001");
    expect(userMsg!.content).toContain("Follow @UniverseDecoded");
    expect(userMsg!.content).toContain("42");
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

    expect(result.scriptQA?.status).toBe("approved");
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.telemetry?.ScriptQA.retries).toBe(1);
  });

  it("signals retry (infra) after all attempts fail", async () => {
    mockGenerate.mockResolvedValue(buildResponse({ content: "bad json" }));

    const { promise } = runNode();
    const result = await promise;

    expect(result.scriptQA?.status).toBe("retry");
    expect(result.scriptQA?.feedback).toContain("Script QA");
    expect(mockGenerate).toHaveBeenCalledTimes(3);
  });

  it("signals retry (infra) on model error", async () => {
    mockGenerate.mockRejectedValue(new Error("OpenRouter timeout"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.scriptQA?.status).toBe("retry");
    expect(result.scriptQA?.feedback).toContain("OpenRouter timeout");
    expect(mockGenerate).toHaveBeenCalledTimes(3);
  });

  it("returns minor_revision immediately when no script exists", async () => {
    const { promise } = runNode({ content: {} } as any);
    const result = await promise;

    expect(result.scriptQA?.status).toBe("minor_revision");
    expect(result.scriptQA?.feedback).toContain("no script or narration");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("loads prompt from expected path", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise, mocks } = runNode();
    await promise;

    expect(mocks.loadPrompt).toHaveBeenCalledWith("script-qa/v1.md");
  });

  it("telemetry records basic fields", async () => {
    mockGenerate.mockResolvedValue(buildResponse());

    const { promise } = runNode();
    const result = await promise;

    const telemetry = result.diagnostics?.telemetry?.ScriptQA;
    expect(telemetry).toBeDefined();
    expect(telemetry!.durationMs).toBeGreaterThanOrEqual(0);
    expect(telemetry!.model).toBe("test-model");
    expect(telemetry!.promptTokens).toBe(15);
    expect(telemetry!.completionTokens).toBe(30);
    expect(telemetry!.promptVersion).toBe("script-qa/v1");
    expect(telemetry!.agentVersion).toBe("1.0.0");
  });
});
