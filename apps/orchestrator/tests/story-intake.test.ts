import { describe, expect, it, jest } from "@jest/globals";
import { storyIntakeNode } from "../src/agents/story-intake.node.js";
import type { ProjectState } from "../src/types/index.js";

const emptyState = {
  project: { pillar: "", topic: "" },
  execution: { version: "0.2.0" },
} as ProjectState;

describe("storyIntakeNode", () => {
  it("maps a reserved sheet row into project state", async () => {
    const reserveRandom = jest.fn(async (_threadId: string) => ({
      rowNumber: 7,
      category: "History",
      workingTitle: "The forgotten city",
      narrationDraft: "It disappeared from every map.",
    }));
    const result = await storyIntakeNode(emptyState, {
      configurable: {
        thread_id: "thread-7",
        storySource: { reserveRandom },
      },
    });

    expect(reserveRandom).toHaveBeenCalledWith("thread-7");
    expect(result.project).toEqual({
      projectId: "thread-7",
      pillar: "History",
      topic:
        "Working Title: The forgotten city\n\nNarration Draft:\nIt disappeared from every map.",
    });
    expect(result.execution.runId).toBe("thread-7");
  });

  it("preserves explicit project input without reading the sheet", async () => {
    const reserveRandom = jest.fn();
    const result = await storyIntakeNode(
      {
        ...emptyState,
        project: { pillar: "Science", topic: "Black holes" },
      },
      { configurable: { storySource: { reserveRandom } } },
    );

    expect(reserveRandom).not.toHaveBeenCalled();
    expect(result.project).toEqual({});
  });
});
