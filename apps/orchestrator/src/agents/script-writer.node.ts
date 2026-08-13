import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Content,
  Diagnostics,
  Execution,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ScriptWriterOutputSchema } from "../schemas/script-writer-output.js";
import type { ScriptWriterOutput } from "../schemas/script-writer-output.js";
import { resolveBranding } from "../utils/branding.js";

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
        viewerQuestion: string;
        curiosityQuestion?: string;
        keyMessage: string;
        referencedFacts: string[];
        priority: string;
        estimatedDurationSeconds: number;
      }[]
    | undefined,
): string {
  if (!beats || beats.length === 0) return "";
  return beats
    .map(
      (b) =>
        `Beat ${b.beatId}\nPriority: ${b.priority.toUpperCase()}\nDuration: ${b.estimatedDurationSeconds} sec\nPurpose: ${b.purpose}\nViewer Question: ${b.viewerQuestion}\nCuriosity Question: ${b.curiosityQuestion ?? ""}\nKey Message: ${b.keyMessage}\nReferenced Facts: ${b.referencedFacts.join(", ")}`,
    )
    .join("\n\n");
}

export async function scriptWriterNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  content: Partial<Content>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { title, hook } = state.content ?? {};
  const research = state.research;
  const storyPlan = state.storyPlan;
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount = (state.execution?.retryCount?.ScriptWriter ?? 0) + 1;

  if (!research?.summary && (!research?.facts || research.facts.length === 0)) {
    return {
      // Clear generated fields (keep title/hook owned by ScriptPlanner): the
      // merge reducer would otherwise let a stale script pass the guard.
      content: { script: "", narration: "", callToAction: "" },
      diagnostics: {
        errors: [
          `${AgentModel.ScriptWriter}: research is required before script generation.`,
        ],
      },
      execution: {
        currentNode: AgentModel.ScriptWriter,
        retryCount: {
          ...state.execution?.retryCount,
          ScriptWriter: retryCount,
        },
      },
    };
  }

  if (!storyPlan?.storyBeats || storyPlan.storyBeats.length === 0) {
    return {
      // Clear generated fields (keep title/hook owned by ScriptPlanner): the
      // merge reducer would otherwise let a stale script pass the guard.
      content: { script: "", narration: "", callToAction: "" },
      diagnostics: {
        errors: [
          `${AgentModel.ScriptWriter}: story plan is required before script generation.`,
        ],
      },
      execution: {
        currentNode: AgentModel.ScriptWriter,
        retryCount: {
          ...state.execution?.retryCount,
          ScriptWriter: retryCount,
        },
      },
    };
  }

  const branding = resolveBranding(state.branding);

  const scriptQA = state.scriptQA;
  const qaFeedback =
    scriptQA?.status === "minor_revision"
      ? [
          ...(scriptQA.feedback ? [`Feedback: ${scriptQA.feedback}`] : []),
          ...(scriptQA.issues?.length
            ? [`Issues:\n${scriptQA.issues.map((i) => `- ${i}`).join("\n")}`]
            : []),
        ].join("\n")
      : "";

  const result = await runAgent<ScriptWriterOutput>({
    agent: AgentModel.ScriptWriter,
    promptPath: PromptPaths.ScriptWriter,
    schema: ScriptWriterOutputSchema,
    variables: {
      title: title ?? "",
      hook: hook ?? "",
      researchSummary: research?.summary ?? "",
      researchFacts: serializeFacts(research?.facts),
      storyType: storyPlan.storyType ?? "",
      storySummary: storyPlan.storySummary ?? "",
      storyBeats: serializeBeats(storyPlan.storyBeats),
      channel: branding.channel,
      cta: branding.outroCta,
      qaFeedback,
    },
    inject,
    configurable: withTopic(config, state).configurable,
  });

  if (result.error || !result.data) {
    return {
      // Clear generated fields (keep title/hook owned by ScriptPlanner): the
      // merge reducer would otherwise let a stale script pass the guard.
      content: { script: "", narration: "", callToAction: "" },
      diagnostics: {
        errors: [`${AgentModel.ScriptWriter}: ${result.error}`],
        telemetry: { [AgentModel.ScriptWriter]: result.telemetry },
      },
      execution: {
        currentNode: AgentModel.ScriptWriter,
        retryCount: {
          ...state.execution?.retryCount,
          ScriptWriter: retryCount,
        },
      },
    };
  }

  const { content } = result.data;

  return {
    content: {
      script: content.script.trim(),
      narration: content.narration.trim(),
      // CTA is configuration-owned. Never trust model-generated CTA text.
      callToAction: branding.outroCta,
      estimatedDurationSeconds: content.estimatedDurationSeconds,
      ...(content.ending
        ? {
            ending: {
              ...content.ending,
              narration: content.ending.narration.trim(),
              visualDirection: content.ending.visualDirection?.trim(),
            },
          }
        : {}),
    },
    diagnostics: {
      telemetry: { [AgentModel.ScriptWriter]: result.telemetry },
    },
    execution: {
      currentNode: AgentModel.ScriptWriter,
      retryCount: { ...state.execution?.retryCount, ScriptWriter: retryCount },
    },
  };
}
