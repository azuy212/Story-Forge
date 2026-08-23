import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectInfo,
  ProjectState,
  Diagnostics,
  Execution,
} from "../types/index.js";
import type { StorySource } from "../providers/story-source.js";
import { GoogleSheetsStorySource } from "../providers/google-sheets-story-source.js";
import { config as appConfig } from "../utils/config.js";

const NODE_NAME = "StoryIntake";

function getThreadId(config: RunnableConfig): string | undefined {
  const configurable = (config.configurable ?? {}) as Record<string, unknown>;
  const value = configurable.thread_id ?? configurable.runId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getStorySource(config: RunnableConfig): StorySource | undefined {
  const configurable = (config.configurable ?? {}) as Record<string, unknown>;
  if (configurable.storySource) {
    return configurable.storySource as StorySource;
  }
  return appConfig.storySheetEnabled()
    ? new GoogleSheetsStorySource()
    : undefined;
}

export async function storyIntakeNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  project: Partial<ProjectInfo>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  if (state.project?.pillar?.trim() && state.project?.topic?.trim()) {
    return {
      project: {},
      diagnostics: {},
      execution: { currentNode: NODE_NAME },
    };
  }

  const source = getStorySource(config);
  if (!source) {
    return {
      project: {},
      diagnostics: {
        errors: [
          `${NODE_NAME}: project input is missing and STORY_SHEET_ENABLED is not true.`,
        ],
      },
      execution: { currentNode: NODE_NAME },
    };
  }

  const threadId = getThreadId(config);
  if (!threadId) {
    return {
      project: {},
      diagnostics: {
        errors: [`${NODE_NAME}: a LangGraph thread_id is required.`],
      },
      execution: { currentNode: NODE_NAME },
    };
  }

  try {
    const story = await source.reserveRandom(threadId);
    return {
      project: {
        projectId: threadId,
        pillar: story.category,
        topic: `Working Title: ${story.workingTitle}\n\nNarration Draft:\n${story.narrationDraft}`,
      },
      diagnostics: {},
      execution: {
        currentNode: NODE_NAME,
        runId: threadId,
        status: "running",
        startedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      project: {},
      diagnostics: {
        errors: [
          `${NODE_NAME}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      },
      execution: { currentNode: NODE_NAME },
    };
  }
}
