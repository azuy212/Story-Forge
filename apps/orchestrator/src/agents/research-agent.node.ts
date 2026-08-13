import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Research,
  Diagnostics,
  Execution,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ResearchOutputSchema } from "../schemas/research-output.js";
import type { ResearchOutput } from "../schemas/research-output.js";

export async function researchAgentNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  research: Partial<Research>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { pillar, topic } = state.project;
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount = (state.execution?.retryCount?.ResearchAgent ?? 0) + 1;

  const qa = state.researchQA;
  const qaFeedback =
    qa?.status === "minor_revision"
      ? [
          ...(qa.feedback ? [`Feedback: ${qa.feedback}`] : []),
          ...(qa.factsToRegenerate
            ? [`Replacements needed: ${qa.factsToRegenerate}`]
            : []),
          ...(qa.issues?.length
            ? [`Issues:\n${qa.issues.map((i) => `- ${i}`).join("\n")}`]
            : []),
        ].join("\n")
      : "";

  const result = await runAgent<ResearchOutput>({
    agent: AgentModel.ResearchAgent,
    promptPath: PromptPaths.ResearchAgent,
    schema: ResearchOutputSchema,
    variables: { pillar, topic, qaFeedback },
    inject,
    configurable: withTopic(config, state).configurable,
  });

  if (result.error || !result.data) {
    return {
      // Clear the channel: the shallow-merge reducer would otherwise keep a
      // previous attempt's research alive and let the guard pass on stale,
      // already-rejected content.
      research: { summary: "", facts: [] },
      diagnostics: {
        errors: [`${AgentModel.ResearchAgent}: ${result.error}`],
        telemetry: { [AgentModel.ResearchAgent]: result.telemetry },
      },
      execution: {
        currentNode: AgentModel.ResearchAgent,
        retryCount: {
          ...state.execution?.retryCount,
          ResearchAgent: retryCount,
        },
      },
    };
  }

  const { summary, facts } = result.data;

  return {
    research: {
      summary: summary.trim(),
      facts: facts.map((f) => ({
        ...f,
        fact: f.fact.trim(),
      })),
    },
    diagnostics: {
      telemetry: { [AgentModel.ResearchAgent]: result.telemetry },
    },
    execution: {
      currentNode: AgentModel.ResearchAgent,
      retryCount: { ...state.execution?.retryCount, ResearchAgent: retryCount },
    },
  };
}
