import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { PromptQAOutputSchema } from "../schemas/prompt-qa-output.js";
import type { PromptQAOutput } from "../schemas/prompt-qa-output.js";
import { config as configUtils } from "../utils/config.js";

function formatScenes(scenes: Scene[]): string {
  return JSON.stringify(
    scenes.map((s) => ({
      sceneId: s.sceneId,
      generationPrompt: s.generationPrompt,
      assetType: s.assetType,
      visualDescription: s.visualDescription,
      narration: s.narration,
    })),
    null,
    2,
  );
}

function formatVisualPlan(
  scenes: Scene[],
  visualPlan: {
    sceneId: number;
    renderStyle: string;
    colorMood: string;
    lighting: string;
    composition: string;
    visualNotes?: string;
  }[],
): string {
  const planMap = new Map(visualPlan.map((p) => [p.sceneId, p]));
  return JSON.stringify(
    scenes.map((s) => {
      const plan = planMap.get(s.sceneId);
      return {
        sceneId: s.sceneId,
        renderStyle: plan?.renderStyle,
        colorMood: plan?.colorMood,
        lighting: plan?.lighting,
        composition: plan?.composition,
        visualNotes: plan?.visualNotes,
      };
    }),
    null,
    2,
  );
}

export async function promptQANode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: { scenes: Scene[]; promptQA?: PromptQAOutput };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const scenes = state.production?.scenes ?? [];
  const visualPlan = state.production?.visualPlan ?? [];
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount = (state.execution?.retryCount?.PromptQA ?? 0) + 1;
  const execution = (currentNode: string) => ({
    currentNode,
    retryCount: { ...state.execution?.retryCount, PromptQA: retryCount },
  });

  if (!configUtils.enablePromptQA()) {
    return {
      production: {
        scenes,
        promptQA: { status: "approved", sceneResults: [] },
      },
      diagnostics: {},
      execution: {},
    };
  }

  if (scenes.length === 0 || !scenes.some((s) => s.generationPrompt)) {
    return {
      production: { scenes },
      diagnostics: {
        errors: [
          `${AgentModel.PromptQA}: No scenes with generation prompts to review`,
        ],
      },
      execution: execution(AgentModel.PromptQA),
    };
  }

  const result = await runAgent<PromptQAOutput>({
    agent: AgentModel.PromptQA,
    promptPath: PromptPaths.PromptQA,
    schema: PromptQAOutputSchema,
    variables: {
      scenes: formatScenes(scenes),
      visualPlan: formatVisualPlan(scenes, visualPlan),
    },
    inject,
    configurable: config.configurable as Record<string, unknown>,
    generateOptions: {
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    // QA infra failure (not a content verdict): signal the router to retry
    // this cheap QA node instead of regenerating prompts.
    return {
      production: {
        scenes,
        promptQA: {
          status: "retry",
          globalFeedback: `Prompt QA: ${result.error}`,
          issues: [result.error ?? "LLM call failed"],
          sceneResults: [],
        },
      },
      diagnostics: {
        telemetry: { [AgentModel.PromptQA]: result.telemetry },
      },
      execution: execution(AgentModel.PromptQA),
    };
  }

  const expectedIds = new Set(scenes.map((s) => s.sceneId));
  const returnedIds = new Set(result.data.sceneResults.map((r) => r.sceneId));
  const missingIds = [...expectedIds].filter((id) => !returnedIds.has(id));
  const extraIds = [...returnedIds].filter((id) => !expectedIds.has(id));
  const errors: string[] = [];

  if (missingIds.length > 0) {
    errors.push(
      `${AgentModel.PromptQA}: Missing results for scenes: [${missingIds.join(", ")}]`,
    );
  }
  if (extraIds.length > 0) {
    errors.push(
      `${AgentModel.PromptQA}: Extra results for unknown scenes: [${extraIds.join(", ")}]`,
    );
  }

  if (errors.length > 0) {
    // A partial scene-result set is a fixable LLM omission: route back to the
    // image prompt generator as a minor revision with explicit feedback.
    return {
      production: {
        scenes,
        promptQA: {
          status: "minor_revision",
          globalFeedback: `Scene coverage mismatch: ${errors.join("; ")}. Review the prompts for the listed scenes and return a complete set.`,
          issues: errors,
          sceneResults: result.data.sceneResults,
        },
      },
      diagnostics: {
        errors,
        telemetry: { [AgentModel.PromptQA]: result.telemetry },
      },
      execution: execution(AgentModel.PromptQA),
    };
  }

  return {
    production: {
      scenes,
      promptQA: result.data,
    },
    diagnostics: {
      telemetry: { [AgentModel.PromptQA]: result.telemetry },
    },
    execution: execution(AgentModel.PromptQA),
  };
}
