import type { RunnableConfig } from "@langchain/core/runnables";
import { withTopic } from "../artifacts/context.js";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ReleaseValidationOutputSchema } from "../schemas/release-validation-output.js";
import type { ReleaseValidationOutput } from "../schemas/release-validation-output.js";
import { config as configUtils } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import { formatLabelFor, resolveVideoProfile } from "../utils/video-profile.js";
import {
  tryClassifyQaGate,
  buildGateState,
  injectFromConfigurable,
} from "../classifiers/index.js";

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

  const label = nodeLabel(AgentModel.ReleaseReview);
  logger.nodeStart(label);
  logger.nodePhase(label, "reviewing release package");

  const videoProfile = state.videoProfile ?? resolveVideoProfile({});

  const gateState = buildGateState("releasereview", state);
  const classified = gateState
    ? await tryClassifyQaGate("releasereview", {
        state: gateState.state,
        agent: AgentModel.ReleaseReview,
        inject: injectFromConfigurable(
          (config.configurable ?? {}) as Record<string, unknown>,
        ),
        promptVersion: PromptPaths.ReleaseReview.replace(/\.md$/, ""),
      })
    : null;

  if (classified && classified.prediction.status === "approved") {
    logger.nodeDone(label, classified.telemetry.durationMs);
    return {
      releaseReview: { status: "approved", issues: [] },
      diagnostics: {
        telemetry: { [AgentModel.ReleaseReview]: classified.telemetry },
      },
      execution: { currentNode: AgentModel.ReleaseReview },
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
      audienceTrigger: state.storyPlan?.audienceTrigger?.type ?? "",
      audienceTriggerStatement:
        state.storyPlan?.audienceTrigger?.statement ?? "",
      audienceTriggerFactIds:
        state.storyPlan?.audienceTrigger?.factIds?.join(", ") ?? "",
      formatLabel: formatLabelFor(videoProfile),
      targetDurationSeconds: String(videoProfile.targetDurationSec),
    },
    inject,
    configurable: withTopic(config, state).configurable,
    generateOptions: {
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    if (classified && classified.prediction.status !== "approved") {
      logger.nodeDone(label, classified.telemetry.durationMs);
      return {
        releaseReview: {
          status: "fatal",
          issues: [result.error ?? "LLM call failed"],
        },
        diagnostics: {
          warnings: [`${AgentModel.ReleaseReview}: ${result.error}`],
          telemetry: { [AgentModel.ReleaseReview]: classified.telemetry },
        },
        execution: { currentNode: AgentModel.ReleaseReview },
      };
    }
    logger.nodeFailed(label, result.error ?? "LLM call failed");
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

  logger.nodeDone(label, result.telemetry.durationMs);

  let releaseReview = result.data;
  if (classified && classified.prediction.status !== "approved") {
    releaseReview = {
      ...releaseReview,
      status: classified.prediction.status as ReleaseValidationOutput["status"],
    };
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  if (releaseReview.status === "fatal") {
    warnings.push(...(releaseReview.issues ?? []));
    errors.push(
      `${AgentModel.ReleaseReview}: ${(releaseReview.issues ?? []).join("; ") || "release package rejected"}`,
    );
  }

  return {
    releaseReview,
    diagnostics: {
      warnings,
      ...(errors.length > 0 ? { errors } : {}),
      telemetry: { [AgentModel.ReleaseReview]: result.telemetry },
    },
    execution: { currentNode: AgentModel.ReleaseReview },
  };
}
