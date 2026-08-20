import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  ScriptQAOutput,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ScriptQAOutputSchema } from "../schemas/script-qa-output.js";
import { config as configUtils } from "../utils/config.js";
import {
  formatScriptComplexityReport,
  validateScriptComplexity,
} from "../utils/script-complexity.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";

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
        ? `\nClassification: ${f.classification}`
        : "";
      return `${f.id}\nConfidence: ${f.confidence}${cls}\n${f.fact}`;
    })
    .join("\n\n");
}

function serializeBeats(
  beats:
    | {
        beatId: number;
        purpose: string;
        curiosityQuestion?: string;
        keyMessage: string;
      }[]
    | undefined,
): string {
  if (!beats || beats.length === 0) return "";
  return beats
    .map((b) => {
      const curiosity = b.curiosityQuestion
        ? `\nCuriosity Question: ${b.curiosityQuestion}`
        : "";
      return `Beat ${b.beatId}\nPurpose: ${b.purpose}${curiosity}\nKey Message: ${b.keyMessage}`;
    })
    .join("\n\n");
}

export async function scriptQANode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  scriptQA: ScriptQAOutput;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { script, narration, callToAction, estimatedDurationSeconds } =
    state.content ?? {};
  const research = state.research;
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount = (state.execution?.retryCount?.ScriptQA ?? 0) + 1;
  const execution = (currentNode: string) => ({
    currentNode,
    retryCount: { ...state.execution?.retryCount, ScriptQA: retryCount },
  });

  if (!script || !narration) {
    return {
      scriptQA: {
        status: "minor_revision",
        feedback: "Script QA: no script or narration to review.",
        issues: ["Missing script or narration"],
      },
      diagnostics: {},
      execution: execution(AgentModel.ScriptQA),
    };
  }

  const complexityReport = validateScriptComplexity(narration);
  const complexityFeedback = formatScriptComplexityReport(complexityReport);

  // Language complexity is a deterministic pipeline invariant. LLM QA can be
  // disabled to save cost, but explicit sentence and language limits still
  // apply before narration reaches TTS.
  if (!complexityReport.passed) {
    return {
      scriptQA: {
        status: "minor_revision",
        feedback: `Script QA: simplify narration for global listening comprehension.\n${complexityFeedback}`,
        issues: complexityReport.issues.map((issue) => issue.message),
      },
      diagnostics: {},
      execution: execution(AgentModel.ScriptQA),
    };
  }

  if (!configUtils.enableScriptQA()) {
    return {
      scriptQA: { status: "approved" } as ScriptQAOutput,
      diagnostics: {},
      execution: {},
    };
  }

  const label = nodeLabel(AgentModel.ScriptQA);
  logger.nodeStart(label);
  logger.nodePhase(label, "checking script");

  const result = await runAgent<ScriptQAOutput>({
    agent: AgentModel.ScriptQA,
    promptPath: PromptPaths.ScriptQA,
    schema: ScriptQAOutputSchema,
    variables: {
      script: script ?? "",
      narration: narration ?? "",
      cta: callToAction ?? "",
      estimatedDurationSeconds: String(estimatedDurationSeconds ?? 50),
      researchFacts: serializeFacts(research?.facts),
      storyBeats: serializeBeats(state.storyPlan?.storyBeats),
      complexityReport: complexityFeedback,
    },
    inject,
    configurable: withTopic(config, state).configurable,
    generateOptions: {
      temperature: 0.3,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    // QA infra failure (not a content verdict): signal the router to retry
    // this cheap QA node instead of regenerating the whole script.
    logger.nodeFailed(label, result.error ?? "LLM call failed");
    return {
      scriptQA: {
        status: "retry",
        feedback: `Script QA: ${result.error}`,
        issues: [result.error ?? "LLM call failed"],
      },
      diagnostics: {
        telemetry: { [AgentModel.ScriptQA]: result.telemetry },
      },
      execution: execution(AgentModel.ScriptQA),
    };
  }

  logger.nodeDone(label, result.telemetry.durationMs);

  return {
    scriptQA: result.data,
    diagnostics: {
      telemetry: { [AgentModel.ScriptQA]: result.telemetry },
    },
    execution: execution(AgentModel.ScriptQA),
  };
}
