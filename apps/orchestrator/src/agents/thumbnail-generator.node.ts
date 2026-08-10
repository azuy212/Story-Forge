import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Thumbnail,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ThumbnailOutputSchema } from "../schemas/thumbnail-output.js";
import type { ThumbnailOutput } from "../schemas/thumbnail-output.js";
import type { AssetProvider } from "../providers/asset-provider.js";
import { createDefaultAssetProvider } from "../providers/asset-provider.js";
import { getArtifactNamespace } from "../artifacts/context.js";

const DEFAULT_PROVIDER = createDefaultAssetProvider();

function getAssetProvider(config: RunnableConfig): AssetProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.assetProvider as AssetProvider) ?? DEFAULT_PROVIDER;
}

export async function thumbnailGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  thumbnail: Partial<Thumbnail>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const inject = (config.configurable ?? {}) as AgentInject;

  const title = state.content?.title;
  if (!title) {
    return {
      thumbnail: {},
      diagnostics: {
        errors: [`${AgentModel.ThumbnailGenerator}: Title is missing`],
      },
      execution: { currentNode: AgentModel.ThumbnailGenerator },
    };
  }

  const hook = state.content?.hook ?? "";
  const narration = state.content?.narration ?? "";
  const channel = state.branding?.channel ?? "";
  const style = state.branding?.style ?? "";
  const colorPalette = state.branding?.colorPalette ?? "";

  const result = await runAgent<ThumbnailOutput>({
    agent: AgentModel.ThumbnailGenerator,
    promptPath: PromptPaths.ThumbnailGenerator,
    schema: ThumbnailOutputSchema,
    variables: {
      title,
      hook,
      narration: narration.slice(0, 200),
      channel,
      style,
      colorPalette,
    },
    inject,
    configurable: config.configurable as Record<string, unknown>,
    generateOptions: {
      temperature: 0.6,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    return {
      thumbnail: {},
      diagnostics: {
        errors: [`${AgentModel.ThumbnailGenerator}: ${result.error}`],
        telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ThumbnailGenerator },
    };
  }

  const provider = getAssetProvider(config);
  let imageUrl: string;

  try {
    const asset = await provider.generateImage({
      prompt: result.data.thumbnailPrompt,
      sceneId: 0,
      filename: "thumbnail.png",
      runId: getArtifactNamespace(config, state),
    });
    imageUrl = asset.url;
  } catch (err) {
    return {
      thumbnail: {},
      diagnostics: {
        errors: [`${AgentModel.ThumbnailGenerator}: Image generation failed: ${(err as Error)?.message ?? String(err)}`],
        telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ThumbnailGenerator },
    };
  }

  return {
    thumbnail: {
      thumbnailPrompt: result.data.thumbnailPrompt,
      thumbnailText: result.data.thumbnailText,
      textPosition: result.data.textPosition,
      colorScheme: result.data.colorScheme,
      imageUrl,
      generatedAt: new Date().toISOString(),
    },
    diagnostics: {
      telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
    },
    execution: { currentNode: AgentModel.ThumbnailGenerator },
  };
}
