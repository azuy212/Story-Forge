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
import type { FactVerdict } from "../schemas/research-qa-output.js";
import { config as configUtils } from "../utils/config.js";
import { hashIssues } from "../utils/qa-policy.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import {
  tryClassifyQaGate,
  buildGateState,
  injectFromConfigurable,
} from "../classifiers/index.js";
import type { QaPrediction } from "../eval/types.js";

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

function factVerdictsFromPrediction(
  prediction: QaPrediction,
  factIds: string[],
): FactVerdict[] {
  return factIds.map((factId) => {
    const raw = prediction.factVerdicts?.[factId];
    const verdict = raw === "remove" || raw === "revise" ? raw : "keep";
    return { factId, verdict, reason: "Classifier verdict" };
  });
}

function regenerateFromVerdicts(factVerdicts: FactVerdict[]): {
  factsToRegenerate: number;
  factsToRegenerateIds: string[];
} {
  const ids = factVerdicts
    .filter((v) => v.verdict === "remove" || v.verdict === "revise")
    .map((v) => v.factId);
  return { factsToRegenerate: ids.length, factsToRegenerateIds: ids };
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
  const execution = (
    currentNode: string,
    qaFeedback?: Record<string, string>,
  ) => ({
    currentNode,
    retryCount: { ...state.execution?.retryCount, ResearchQA: retryCount },
    ...(qaFeedback ? { qaFeedback } : {}),
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
    // No facts at all is a hard failure: script generation needs research.
    const feedback =
      "No facts were collected for review; research is unusable for script generation.";
    return {
      research: {},
      researchQA: {
        status: "fail",
        feedback,
        issues: ["No facts collected"],
        factsToRegenerate: 0,
        factVerdicts: [],
      },
      diagnostics: {
        errors: [`${AgentModel.ResearchQA}: ${feedback}`],
      },
      execution: execution(AgentModel.ResearchQA),
    };
  }

  const label = nodeLabel(AgentModel.ResearchQA);
  logger.nodeStart(label);
  logger.nodePhase(label, "reviewing research quality");

  const gateState = buildGateState("researchqa", state);
  const classified = gateState
    ? await tryClassifyQaGate("researchqa", {
        state: gateState.state,
        factIds: gateState.factIds,
        agent: AgentModel.ResearchQA,
        inject: injectFromConfigurable(
          (config.configurable ?? {}) as Record<string, unknown>,
        ),
        promptVersion: PromptPaths.ResearchQA.replace(/\.md$/, ""),
      })
    : null;

  if (classified && classified.prediction.status === "approved") {
    const factVerdicts = factVerdictsFromPrediction(
      classified.prediction,
      facts.map((f) => f.id),
    );
    const qa: ResearchQAOutput = {
      status: "approved",
      factVerdicts,
      ...regenerateFromVerdicts(factVerdicts),
    };
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

    logger.nodeDone(label, classified.telemetry.durationMs);
    return {
      research: { facts: verifiedFacts },
      researchQA: qa,
      diagnostics: {
        telemetry: { [AgentModel.ResearchQA]: classified.telemetry },
      },
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
    // Trusted non-approved classifier verdict still stands when the LLM
    // cascade fails for prose: return the classifier status instead of retry.
    if (classified && classified.prediction.status !== "approved") {
      const factVerdicts = factVerdictsFromPrediction(
        classified.prediction,
        facts.map((f) => f.id),
      );
      logger.nodeDone(label, classified.telemetry.durationMs);
      return {
        research: {},
        researchQA: {
          status: classified.prediction.status as ResearchQAOutput["status"],
          feedback: `Research QA (classifier): ${classified.prediction.status}`,
          issues: [result.error ?? "LLM call failed"],
          factVerdicts,
          ...regenerateFromVerdicts(factVerdicts),
        },
        diagnostics: {
          telemetry: { [AgentModel.ResearchQA]: classified.telemetry },
        },
        execution: execution(AgentModel.ResearchQA),
      };
    }
    // QA infra failure (not a content verdict): signal the router to retry
    // this cheap QA node instead of regenerating the whole research.
    logger.nodeFailed(label, result.error ?? "LLM call failed");
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

  logger.nodeDone(label, result.telemetry.durationMs);

  let qa = result.data;
  if (classified && classified.prediction.status !== "approved") {
    const factVerdicts = classified.prediction.factVerdicts
      ? factVerdictsFromPrediction(
          classified.prediction,
          facts.map((f) => f.id),
        )
      : qa.factVerdicts;
    qa = {
      ...qa,
      status: classified.prediction.status as ResearchQAOutput["status"],
      factVerdicts,
      ...regenerateFromVerdicts(factVerdicts),
    };
  }

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

  // A revision verdict (minor/major/fail) records its feedback hash so the
  // router can detect repeated feedback and stop regenerating identical input.
  const isRevision =
    qa.status === "minor_revision" ||
    qa.status === "major_revision" ||
    qa.status === "fail";
  const feedbackHash = hashIssues(qa.issues, qa.feedback);
  const previousHash = state.execution?.qaFeedback?.[AgentModel.ResearchQA];
  const repeated = isRevision && previousHash === feedbackHash;

  const qaOutput: ResearchQAOutput = repeated ? { ...qa, repeated: true } : qa;

  return {
    research: {},
    researchQA: qaOutput,
    diagnostics: {
      ...(qa.status === "fail"
        ? {
            errors: [
              `${AgentModel.ResearchQA}: ${qa.feedback ?? "research is unusable for script generation"}`,
            ],
          }
        : {}),
      telemetry: { [AgentModel.ResearchQA]: result.telemetry },
    },
    execution: execution(
      AgentModel.ResearchQA,
      isRevision
        ? {
            ...state.execution?.qaFeedback,
            [AgentModel.ResearchQA]: feedbackHash,
          }
        : undefined,
    ),
  };
}
