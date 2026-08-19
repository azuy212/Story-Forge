import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { releaseReviewNode } from "../src/agents/release-review.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a release reviewer.",
  "---",
  "Channel: {{channel}}",
  "Title: {{title}}",
  "Hook: {{hook}}",
  "Narration:\n{{narration}}",
  "Thumbnail text: {{thumbnailText}}",
  "Metadata: {{metadata}}",
].join("\n");

const MOCK_GUIDELINES = "Editorial guidelines for testing.";

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
  const promise = releaseReviewNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: {
        title: "Test Title",
        hook: "Test hook",
        narration: "Narration text.",
      },
      metadataOutput: {
        title: "Meta Title",
        description: "Meta description.",
        tags: ["geography"],
        hashtags: ["geo"],
        category: "Education",
        pinnedComment: "Comment?",
      },
      thumbnail: {
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      },
      branding: { channel: "TestChannel", creator: "", cta: "" },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: mocks } as any,
  );
  return { promise, mocks };
}

function buildResponse(data: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(data) } }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    model: "test-model",
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("releaseReviewNode", () => {
  it("approved when LLM approves", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildResponse({ status: "approved", issues: [] }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.releaseReview?.status).toBe("approved");
    expect(result.releaseReview?.issues).toEqual([]);
    expect(result.execution?.currentNode).toBe("ReleaseReview");
  });

  it("fatal with issues surfaced as warnings", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildResponse({
        status: "fatal",
        issues: ["Title oversells the content"],
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.releaseReview?.status).toBe("fatal");
    expect(result.diagnostics?.warnings).toContain(
      "Title oversells the content",
    );
  });

  it("fatal on LLM failure", async () => {
    mockGenerate.mockRejectedValue(new Error("API timeout"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.releaseReview?.status).toBe("fatal");
    expect(result.releaseReview?.issues![0]).toBe("API timeout");
  });

  it("passes title, narration and metadata to the model", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildResponse({ status: "approved", issues: [] }),
    );

    const { promise } = runNode();
    await promise;

    const calls = mockGenerate.mock.calls;
    const messages = calls[0][0] as { role: string; content: string }[];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg!.content).toContain("TestChannel");
    expect(userMsg!.content).toContain("Narration text.");
    expect(userMsg!.content).toContain("Meta description.");
    expect(userMsg!.content).toContain("geography");
  });

  it("telemetry recorded", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildResponse({ status: "approved", issues: [] }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.telemetry?.ReleaseReview).toBeDefined();
  });

  it("skips when disabled", async () => {
    const prevRelease = process.env.ENABLE_RELEASE_QA;
    const prevQa = process.env.ENABLE_QA;
    process.env.ENABLE_RELEASE_QA = "false";
    process.env.ENABLE_QA = "false";
    try {
      const { promise } = runNode();
      const result = await promise;
      expect(result.releaseReview?.status).toBe("approved");
      expect(result.releaseReview?.issues).toEqual([]);
      expect(mockGenerate).not.toHaveBeenCalled();
    } finally {
      if (prevRelease === undefined) delete process.env.ENABLE_RELEASE_QA;
      else process.env.ENABLE_RELEASE_QA = prevRelease;
      if (prevQa === undefined) delete process.env.ENABLE_QA;
      else process.env.ENABLE_QA = prevQa;
    }
  });
});
