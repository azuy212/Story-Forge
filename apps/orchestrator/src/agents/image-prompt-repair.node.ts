import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ImagePromptRepairOutputSchema } from "../schemas/image-prompt-repair-output.js";
import type { ImagePromptRepairOutput } from "../schemas/image-prompt-repair-output.js";
import type { ImageGenerationError } from "../providers/image-generation-error.js";
import { MAX_PROMPT_REPAIRS } from "../utils/constants.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";

const UNRESOLVED_REJECTION = "unresolved_provider_rejection";
const REPAIR_LLM_FAILURE = "prompt_repair_failed";

/**
 * A scene still within the repair budget and awaiting another LLM repair.
 * Shared by the graph router and the repair node so the two stay in lockstep.
 */
export function isAwaitingRepair(scene: Scene): boolean {
  return (
    scene.generationStatus === "prompt_repair" &&
    (scene.repairCount ?? 0) < MAX_PROMPT_REPAIRS
  );
}

function providerErrorForScene(scene: Scene): ImageGenerationError | null {
  const err = scene.providerError;
  if (!err?.message) return null;
  return {
    provider: err.provider,
    model: err.model ?? "unknown",
    type: (err.type ?? "unknown") as ImageGenerationError["type"],
    message: err.message,
    rawMessage: err.rawMessage,
    retryable: err.retryable ?? false,
    originalPrompt: err.originalPrompt ?? scene.originalPrompt ?? "",
    sceneId: scene.sceneId,
    timestamp: err.timestamp ?? new Date().toISOString(),
  };
}

function attemptsJson(scene: Scene): string {
  const attempts = (scene.promptAttempts ?? []).map((attempt) => ({
    attempt: attempt.attempt,
    prompt: attempt.prompt,
    status: attempt.status,
    errorType: attempt.errorType,
    providerMessage: attempt.providerMessage,
  }));
  return JSON.stringify(attempts, null, 2);
}

export async function imagePromptRepairNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: { scenes: Scene[] };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const startedAt = Date.now();
  const scenes = state.production?.scenes ?? [];
  const inject = (config.configurable ?? {}) as AgentInject;

  const pending = scenes.filter(isAwaitingRepair);

  if (pending.length === 0) {
    return {
      production: { scenes },
      diagnostics: {},
      execution: { currentNode: AgentModel.ImagePromptRepair },
    };
  }

  const label = nodeLabel(AgentModel.ImagePromptRepair);
  logger.nodeStart(label);
  logger.nodePhase(label, "repairing rejected prompts");

  const repaired = [...scenes];

  for (const scene of pending) {
    const targetId = scene.sceneId;
    const index = repaired.findIndex((s) => s.sceneId === targetId);
    const current = repaired[index];

    const providerError = providerErrorForScene(scene);
    if (!providerError) {
      logger.warn(
        "ImagePromptRepair: scene flagged for repair without provider error",
        {
          sceneId: targetId,
        },
      );
      // Fail closed: a repair-flagged scene with no error to repair against
      // would otherwise loop between the repair node and the generator.
      repaired[index] = {
        ...current,
        generationStatus: "failed",
        failureType: "invalid_repair_state",
      };
      continue;
    }

    const result = await runAgent<ImagePromptRepairOutput>({
      agent: AgentModel.ImagePromptRepair,
      promptPath: PromptPaths.ImagePromptRepair,
      schema: ImagePromptRepairOutputSchema,
      variables: {
        sceneId: String(targetId),
        sceneType: scene.sceneType ?? "",
        assetMode: scene.assetMode ?? "generated",
        visualDescription: scene.visualDescription ?? "",
        narration: scene.narration ?? "",
        entities: JSON.stringify(scene.entities ?? []),
        visualPlan: JSON.stringify(
          state.production?.visualPlan?.find((p) => p.sceneId === targetId) ??
            {},
        ),
        originalPrompt: scene.originalPrompt ?? scene.generationPrompt ?? "",
        providerError: JSON.stringify(providerError, null, 2),
        previousAttempts: attemptsJson(scene),
      },
      inject,
      configurable: withTopic(config, state).configurable,
      deferComplete: false,
    });

    if (result.error || !result.data) {
      logger.error("ImagePromptRepair LLM call failed", {
        sceneId: targetId,
        error: result.error,
      });
      // Repair infra failure: fail closed instead of looping the same repair
      // request forever. The user can rerun the pipeline once the LLM issue
      // is resolved.
      repaired[index] = {
        ...current,
        generationStatus: "failed",
        failureType: REPAIR_LLM_FAILURE,
      };
      continue;
    }

    const output = result.data;
    if (!output.shouldRetry || !output.repairedPrompt.trim()) {
      repaired[index] = {
        ...current,
        generationStatus: "failed",
        failureType: UNRESOLVED_REJECTION,
      };
      continue;
    }

    const trimmedPrompt = output.repairedPrompt.trim();
    const repeatsPriorAttempt = (current.promptAttempts ?? []).some(
      (attempt) => attempt.prompt === trimmedPrompt,
    );
    if (repeatsPriorAttempt) {
      // The model echoed a prompt that already failed: bounded by logic, not
      // by model compliance. Fail closed so the loop cannot spin.
      logger.warn(
        "ImagePromptRepair produced a prompt identical to a prior attempt",
        { sceneId: targetId, repairCount: current.repairCount ?? 0 },
      );
      repaired[index] = {
        ...current,
        generationStatus: "failed",
        failureType: UNRESOLVED_REJECTION,
      };
      continue;
    }

    const repairCount = (current.repairCount ?? 0) + 1;
    repaired[index] = {
      ...current,
      generationPrompt: trimmedPrompt,
      repairedPrompt: trimmedPrompt,
      originalPrompt: current.originalPrompt ?? current.generationPrompt,
      repairCount,
      // Every repaired prompt is attempted once by the generator. The budget
      // counts LLM repair calls; a rejection past the ceiling fails the scene
      // in AssetGenerator, so the last repair is never a wasted LLM call.
      generationStatus: "pending",
      providerError: undefined,
    };

    logger.info("ImagePromptRepair repaired prompt", {
      sceneId: scene.sceneId,
      repairCount,
      changes: output.changes,
      reason: output.reason,
      exhausted: repairCount >= MAX_PROMPT_REPAIRS,
    });
  }

  logger.nodeDone(label, Date.now() - startedAt);

  return {
    production: { scenes: repaired },
    diagnostics: {},
    execution: { currentNode: AgentModel.ImagePromptRepair },
  };
}
