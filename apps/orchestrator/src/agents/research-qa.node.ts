import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Research,
  ResearchQAOutput,
  Diagnostics,
  Execution,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ResearchQAOutputSchema } from "../schemas/research-qa-output.js";
import { config as configUtils } from "../utils/config.js";

function serializeFacts(
  facts:
    | {
        id: string;
        fact: string;
        confidence: string;
        classification?: string;
      }[]
    | undefined,
): string {
  if (!facts || facts.length === 0) return "";
  return facts
    .map((f) => {
      const cls = f.classification
        ? ` (classification: ${f.classification})`
        : "";
      return `- ${f.id} (confidence: ${f.confidence})${cls}: ${f.fact}`;
    })
    .join("\n");
}

export async function researchQANode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  research: Partial<Research>;
  researchQA: Partial<ResearchQAOutput>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { pillar, topic } = state.project;
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount = (state.execution?.retryCount?.ResearchQA ?? 0) + 1;
  const execution = (currentNode: string) => ({
    currentNode,
    retryCount: { ...state.execution?.retryCount, ResearchQA: retryCount },
  });

  if (!configUtils.enableResearchQA()) {
    return {
      research: {},
      researchQA: { status: "approved", factVerdicts: [] } as ResearchQAOutput,
      diagnostics: {},
      execution: {},
    };
  }

  const facts = state.research?.facts ?? [];

  if (facts.length === 0) {
    return {
      research: {},
      researchQA: {
        status: "minor_revision",
        feedback: "No facts were collected for review.",
        issues: ["No facts collected"],
        factsToRegenerate: 0,
        factVerdicts: [],
      },
      diagnostics: {},
      execution: execution(AgentModel.ResearchQA),
    };
  }

  const result = await runAgent<ResearchQAOutput>({
    agent: AgentModel.ResearchQA,
    promptPath: PromptPaths.ResearchQA,
    schema: ResearchQAOutputSchema,
    variables: {
      pillar,
      topic,
      summary: state.research?.summary ?? "",
      facts: serializeFacts(facts),
    },
    inject,
    configurable: withTopic(config, state).configurable,
    generateOptions: {
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    // QA infra failure (not a content verdict): signal the router to retry
    // this cheap QA node instead of regenerating the whole research.
    return {
      research: {},
      researchQA: {
        status: "retry",
        feedback: `Research QA: ${result.error}`,
        issues: [result.error ?? "LLM call failed"],
        factsToRegenerate: 0,
        factVerdicts: [],
      },
      diagnostics: {
        telemetry: { [AgentModel.ResearchQA]: result.telemetry },
      },
      execution: execution(AgentModel.ResearchQA),
    };
  }

  const qa = result.data;

  if (qa.status === "approved") {
    const verdicts = new Map(qa.factVerdicts.map((v) => [v.factId, v]));
    const verifiedFacts = facts.map((f) => {
      const v = verdicts.get(f.id);
      if (!v) return f;
      if (v.verdict !== "keep") return f;
      return {
        ...f,
        verified: true as const,
        reason: v.reason,
        classification: v.classification ?? f.classification,
      };
    });

    return {
      research: { facts: verifiedFacts },
      researchQA: qa,
      diagnostics: {
        telemetry: { [AgentModel.ResearchQA]: result.telemetry },
      },
      execution: execution(AgentModel.ResearchQA),
    };
  }

  return {
    research: {},
    researchQA: qa,
    diagnostics: {
      telemetry: { [AgentModel.ResearchQA]: result.telemetry },
    },
    execution: execution(AgentModel.ResearchQA),
  };
}
