import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { MetadataOutputSchema } from "../schemas/metadata-output.js";
import type { MetadataOutput } from "../schemas/metadata-output.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";

function hasMetadataOutput(state: ProjectState): boolean {
  return (
    !!state.metadataOutput?.title &&
    !!state.metadataOutput?.description &&
    (state.metadataOutput?.tags?.length ?? 0) > 0
  );
}

export async function metadataGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  metadataOutput: MetadataOutput | null;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const inject = (config.configurable ?? {}) as AgentInject;

  // Idempotent on graph re-entry: any re-entry through VisualDirector
  // (e.g. a QA router sending work back) re-fires this branch, and the
  // existing output must be kept instead of regenerated.
  if (hasMetadataOutput(state)) {
    return {
      metadataOutput: state.metadataOutput ?? null,
      diagnostics: {},
      execution: { currentNode: AgentModel.MetadataGenerator },
    };
  }

  const script = state.content?.script;
  const title = state.content?.title;
  const hook = state.content?.hook;
  const channel = state.branding?.channel ?? "";

  if (!script || !title || !hook) {
    return {
      metadataOutput: null,
      diagnostics: {
        errors: [
          `${AgentModel.MetadataGenerator}: Script, title, or hook missing`,
        ],
      },
      execution: { currentNode: AgentModel.MetadataGenerator },
    };
  }

  const label = nodeLabel(AgentModel.MetadataGenerator);
  logger.nodeStart(label);
  logger.nodePhase(label, "generating metadata");

  const result = await runAgent<MetadataOutput>({
    agent: AgentModel.MetadataGenerator,
    promptPath: PromptPaths.MetadataGenerator,
    schema: MetadataOutputSchema,
    variables: { script, title, hook, channel },
    inject,
    configurable: withTopic(config, state).configurable,
    generateOptions: {
      temperature: 0.3,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    logger.nodeFailed(label, result.error ?? "Unknown LLM error");
    return {
      metadataOutput: null,
      diagnostics: {
        errors: [`${AgentModel.MetadataGenerator}: ${result.error}`],
        telemetry: { [AgentModel.MetadataGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.MetadataGenerator },
    };
  }

  logger.nodeDone(label, result.telemetry.durationMs);

  return {
    metadataOutput: result.data,
    diagnostics: {
      telemetry: { [AgentModel.MetadataGenerator]: result.telemetry },
    },
    execution: { currentNode: AgentModel.MetadataGenerator },
  };
}
