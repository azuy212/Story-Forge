import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { MetadataOutputSchema } from "../schemas/metadata-output.js";
import type { MetadataOutput } from "../schemas/metadata-output.js";

export async function metadataGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  metadataOutput: MetadataOutput | null;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const inject = (config.configurable ?? {}) as AgentInject;

  const script = state.content?.script;
  const title = state.content?.title;
  const hook = state.content?.hook;
  const channel = state.branding?.channel ?? "";

  if (!script || !title || !hook) {
    return {
      metadataOutput: null,
      diagnostics: {
        errors: [`${AgentModel.MetadataGenerator}: Script, title, or hook missing`],
      },
      execution: { currentNode: AgentModel.MetadataGenerator },
    };
  }

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
    return {
      metadataOutput: null,
      diagnostics: {
        errors: [`${AgentModel.MetadataGenerator}: ${result.error}`],
        telemetry: { [AgentModel.MetadataGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.MetadataGenerator },
    };
  }

  return {
    metadataOutput: result.data,
    diagnostics: {
      telemetry: { [AgentModel.MetadataGenerator]: result.telemetry },
    },
    execution: { currentNode: AgentModel.MetadataGenerator },
  };
}
