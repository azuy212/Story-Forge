import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ReleaseValidationOutputSchema } from "../schemas/release-validation-output.js";
import type { ReleaseValidationOutput } from "../schemas/release-validation-output.js";
import { config as configUtils } from "../utils/config.js";

function serializeMetadata(
  meta:
    | {
        title?: string;
        description?: string;
        tags?: string[];
        hashtags?: string[];
        category?: string;
        pinnedComment?: string;
      }
    | undefined,
): string {
  if (!meta) return "No metadata provided.";
  return JSON.stringify(
    {
      title: meta.title ?? "",
      description: meta.description ?? "",
      tags: meta.tags ?? [],
      hashtags: meta.hashtags ?? [],
      category: meta.category ?? "",
      pinnedComment: meta.pinnedComment ?? "",
    },
    null,
    2,
  );
}

export async function releaseReviewNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  releaseReview: Partial<ReleaseValidationOutput>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const inject = (config.configurable ?? {}) as AgentInject;

  if (!configUtils.enableReleaseQA()) {
    return {
      releaseReview: { status: "approved", issues: [] },
      diagnostics: {},
      execution: {},
    };
  }

  const result = await runAgent<ReleaseValidationOutput>({
    agent: AgentModel.ReleaseReview,
    promptPath: PromptPaths.ReleaseReview,
    schema: ReleaseValidationOutputSchema,
    variables: {
      channel: state.branding?.channel ?? "",
      title: state.content?.title ?? "",
      hook: state.content?.hook ?? "",
      narration: state.content?.narration ?? "",
      thumbnailText: state.thumbnail?.thumbnailText ?? "",
      metadata: serializeMetadata(state.metadataOutput),
    },
    inject,
    configurable: config.configurable as Record<string, unknown>,
    generateOptions: {
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    return {
      releaseReview: {
        status: "fatal",
        issues: [result.error ?? "LLM call failed"],
      },
      diagnostics: {
        warnings: [`${AgentModel.ReleaseReview}: ${result.error}`],
        telemetry: { [AgentModel.ReleaseReview]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ReleaseReview },
    };
  }

  const warnings: string[] = [];
  if (result.data.status === "fatal") {
    warnings.push(...(result.data.issues ?? []));
  }

  return {
    releaseReview: result.data,
    diagnostics: {
      warnings,
      telemetry: { [AgentModel.ReleaseReview]: result.telemetry },
    },
    execution: { currentNode: AgentModel.ReleaseReview },
  };
}
