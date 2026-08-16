import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Scene,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { completeArtifactForNode } from "../artifacts/cache.js";
import { withTopic } from "../artifacts/context.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ImagePromptOutputSchema } from "../schemas/image-prompt-output.js";
import type { ImagePromptOutput } from "../schemas/image-prompt-output.js";
import { logger } from "../utils/logger.js";
import { padSceneId } from "../utils/scene-id.js";

export async function imagePromptGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  production?: { scenes: Scene[] };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const scenes = state.production?.scenes ?? [];
  const visualPlan = state.production?.visualPlan ?? [];
  const promptQA = state.production?.promptQA;
  const { pillar, topic } = state.project;
  const { style, colorPalette, logo } = state.branding ?? {};
  const inject = (config.configurable ?? {}) as AgentInject;

  const retryCount =
    (state.execution?.retryCount?.ImagePromptGenerator ?? 0) + 1;

  if (scenes.length === 0) {
    return {
      diagnostics: {
        errors: [`${AgentModel.ImagePromptGenerator}: No scenes to process`],
      },
      execution: {
        currentNode: AgentModel.ImagePromptGenerator,
        retryCount: {
          ...state.execution?.retryCount,
          ImagePromptGenerator: retryCount,
        },
      },
    };
  }

  const planMap = new Map(visualPlan.map((p) => [p.sceneId, p]));

  const scenesJson = JSON.stringify(
    scenes.map((s) => {
      const plan = planMap.get(s.sceneId);
      return {
        sceneId: s.sceneId,
        sceneType: s.sceneType,
        assetMode: s.assetMode ?? "generated",
        entities: s.entities,
        sourceAssetIds: s.sourceAssetIds,
        visualDescription: s.visualDescription,
        narration: s.narration,
        renderStyle: plan?.renderStyle,
        colorMood: plan?.colorMood,
        lighting: plan?.lighting,
        composition: plan?.composition,
        visualNotes: plan?.visualNotes,
      };
    }),
    null,
    2,
  );

  const needsRevise =
    promptQA?.status === "minor_revision" ||
    promptQA?.status === "major_revision";
  const qaFeedback =
    needsRevise && promptQA.sceneResults
      ? JSON.stringify(
          {
            globalFeedback: promptQA.globalFeedback,
            sceneResults: promptQA.sceneResults,
          },
          null,
          2,
        )
      : "";

  // Snapshot the previous attempt's prompts BEFORE the wipe below so a
  // revision run can see what it produced before (the QA verdicts reference
  // these prompts). Only populated when a revision actually occurred.
  const previousPrompts = needsRevise
    ? JSON.stringify(
        scenes
          .filter((s) => s.generationPrompt)
          .map((s) => ({
            sceneId: s.sceneId,
            generationPrompt: s.generationPrompt,
          })),
        null,
        2,
      )
    : "";

  const expectedIds = new Set(scenes.map((s) => s.sceneId));
  const maxAttempts = 2;

  // On failure, prompts from a previous attempt must not survive: they were
  // either never produced or already rejected by PromptQA, and the merge
  // reducer would let them pass hasScenePrompts again.
  const clearedScenes: Scene[] = scenes.map((s) => ({
    ...s,
    generationPrompt: undefined,
    promptId: undefined,
  }));

  type AssetPrompt = ImagePromptOutput["assets"][number];
  const collected = new Map<number, AssetPrompt>();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const stillMissing = [...expectedIds].filter((id) => !collected.has(id));
    // Retry is targeted: attempt 2 asks only for what attempt 1 omitted
    // instead of re-rolling the full scene set.
    const missingHint =
      attempt > 1 && stillMissing.length > 0
        ? `\nYour previous attempt was incomplete. Return assets ONLY for scene IDs: [${stillMissing.join(", ")}]. Do not return assets for other scenes.`
        : "";

    const result = await runAgent<ImagePromptOutput>({
      agent: AgentModel.ImagePromptGenerator,
      promptPath: PromptPaths.ImagePromptGenerator,
      schema: ImagePromptOutputSchema,
      singleAttempt: true,
      variables: {
        pillar: pillar ?? "",
        topic: topic ?? "",
        style: style ?? "",
        colorPalette: colorPalette ?? "",
        logo: logo ?? "",
        scenes: scenesJson,
        qaFeedback: `${qaFeedback}${missingHint}`,
        previousPrompts,
      },
      inject,
      configurable: withTopic(config, state).configurable,
      deferComplete: true,
    });
    if (result.error || !result.data) {
      if (attempt < maxAttempts) {
        logger.warn("ImagePromptGenerator agent call failed, retrying", {
          attempt,
          error: result.error,
        });
        continue;
      }
      return {
        production: { scenes: clearedScenes },
        diagnostics: {
          errors: [`${AgentModel.ImagePromptGenerator}: ${result.error}`],
          telemetry: {
            [AgentModel.ImagePromptGenerator]: {
              ...result.telemetry,
              retries: attempt - 1,
            },
          },
        },
        execution: {
          currentNode: AgentModel.ImagePromptGenerator,
          retryCount: {
            ...state.execution?.retryCount,
            ImagePromptGenerator: retryCount,
          },
        },
      };
    }

    const assets = result.data.assets;
    const extras = assets.filter((a) => !expectedIds.has(a.sceneId));
    for (const asset of assets) {
      if (expectedIds.has(asset.sceneId)) {
        collected.set(asset.sceneId, asset);
      }
    }

    if (extras.length > 0) {
      logger.warn("ImagePromptGenerator returned assets for unknown scenes", {
        attempt,
        extras: extras.map((a) => a.sceneId),
      });
    }

    const remaining = [...expectedIds].filter((id) => !collected.has(id));

    if (remaining.length === 0) {
      await completeArtifactForNode(
        config,
        AgentModel.ImagePromptGenerator,
        state,
      );
      const updatedScenes: Scene[] = scenes.map((scene) => {
        const asset = collected.get(scene.sceneId);
        if (!asset) return scene;
        return {
          ...scene,
          generationPrompt: asset.generationPrompt.trim(),
          assetType: asset.assetType,
          promptId: `prompt-scene-${padSceneId(scene.sceneId)}`,
        };
      });

      return {
        production: { scenes: updatedScenes },
        diagnostics: {
          telemetry: {
            [AgentModel.ImagePromptGenerator]: {
              ...result.telemetry,
              retries: attempt - 1,
            },
          },
        },
        execution: {
          currentNode: AgentModel.ImagePromptGenerator,
          retryCount: {
            ...state.execution?.retryCount,
            ImagePromptGenerator: retryCount,
          },
        },
      };
    }

    if (attempt < maxAttempts) {
      logger.warn("ImagePromptGenerator asset mapping incomplete, retrying", {
        attempt,
        missing: remaining,
      });
    } else {
      return {
        production: { scenes: clearedScenes },
        diagnostics: {
          errors: [
            `${AgentModel.ImagePromptGenerator}: Incomplete asset mapping after ${maxAttempts} attempts. Missing scenes: [${remaining.join(", ")}].`,
          ],
          telemetry: {
            [AgentModel.ImagePromptGenerator]: {
              ...result.telemetry,
              retries: attempt - 1,
            },
          },
        },
        execution: {
          currentNode: AgentModel.ImagePromptGenerator,
          retryCount: {
            ...state.execution?.retryCount,
            ImagePromptGenerator: retryCount,
          },
        },
      };
    }
  }

  return {
    production: { scenes: clearedScenes },
    diagnostics: {
      errors: [
        `${AgentModel.ImagePromptGenerator}: Unexpected exit from retry loop`,
      ],
    },
    execution: { currentNode: AgentModel.ImagePromptGenerator },
  };
}
