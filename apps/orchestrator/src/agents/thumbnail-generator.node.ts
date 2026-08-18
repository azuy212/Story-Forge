import fs from "node:fs";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Thumbnail,
  ThumbnailImageOutput,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ThumbnailOutputSchema } from "../schemas/thumbnail-output.js";
import type { ThumbnailOutput } from "../schemas/thumbnail-output.js";
import type { AssetProvider } from "../providers/asset-provider.js";
import { createDefaultAssetProvider } from "../providers/asset-provider.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { getArtifactNamespace } from "../artifacts/context.js";
import type {
  ThumbnailCompositor,
  ThumbnailTextPosition,
} from "../providers/thumbnail-compositor.js";
import {
  createDefaultThumbnailCompositor,
  normalizeTextPosition,
} from "../providers/thumbnail-compositor.js";

const DEFAULT_PROVIDER = createDefaultAssetProvider();
const DEFAULT_COMPOSITOR = createDefaultThumbnailCompositor();

const TEXT_POSITION_HINT: Record<ThumbnailTextPosition, string> = {
  "bottom-third": "bottom third of the frame",
  "top-left": "top-left corner region",
  "top-right": "top-right corner region",
  center: "central horizontal band across the middle of the frame",
};

export function isUsableThumbnailImage(data: ThumbnailImageOutput): boolean {
  if (!data.imageUrl || data.width !== 1080 || data.height !== 1920) {
    return false;
  }

  // Provider URLs are durable references; local compositor paths must still
  // exist when an artifact-cache hit is reused.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(data.imageUrl)) return true;
  return fs.existsSync(data.imageUrl);
}

function getAssetProvider(config: RunnableConfig): AssetProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.assetProvider as AssetProvider) ?? DEFAULT_PROVIDER;
}

function getThumbnailCompositor(config: RunnableConfig): ThumbnailCompositor {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (
    (inject.thumbnailCompositor as ThumbnailCompositor) ?? DEFAULT_COMPOSITOR
  );
}

/**
 * Append authoritative layout instructions to the LLM-generated thumbnail
 * prompt. The image model is told to leave the text area clean and to never
 * render text itself; the deterministic FFmpeg compositor is the only thing
 * that draws the thumbnail text.
 */
export function buildGenerationPrompt(
  thumbnailPrompt: string,
  thumbnailText: string,
  textPosition: ThumbnailTextPosition,
): string {
  return [
    thumbnailPrompt,
    "",
    "PIPELINE OVERLAY NOTE (authoritative, follow exactly):",
    "- Output a vertical 9:16 image at 1080x1920 pixels.",
    "- Do NOT render any text, letters, words, numbers, or typography anywhere in the image.",
    `- The overlay text "${thumbnailText}" will be added by the pipeline after generation; do not draw it.`,
    `- Keep the ${TEXT_POSITION_HINT[textPosition]} visually clean (plain background, no subject, no clutter) to make room for that overlay.`,
    "- Keep the focal subject within the central safe area of the frame.",
  ].join("\n");
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
  const compositor = getThumbnailCompositor(config);
  const runId = getArtifactNamespace(config, state);

  const thumbnailText = result.data.thumbnailText.trim();
  const textPosition = normalizeTextPosition(result.data.textPosition);
  const colorScheme = result.data.colorScheme;
  const generationPrompt = buildGenerationPrompt(
    result.data.thumbnailPrompt,
    thumbnailText,
    textPosition,
  );

  const imageResult = await cacheNodeResult<ThumbnailImageOutput>(
    {
      type: "thumbnailImage",
      node: "ThumbnailCompositor",
      key: {
        prompt: generationPrompt,
        thumbnailText,
        textPosition,
        compositor: compositor.fingerprint(),
        provider: provider.constructor.name,
      },
      validate: isUsableThumbnailImage,
    },
    async () => {
      try {
        const asset = await provider.generateImage({
          prompt: generationPrompt,
          sceneId: 0,
          filename: "thumbnail.png",
          runId,
        });

        const composited = await compositor.composite({
          sourceUrl: asset.url,
          text: thumbnailText,
          textPosition,
          colorScheme,
          runId,
          filename: "thumbnail-composited.png",
        });

        if (composited.width !== 1080 || composited.height !== 1920) {
          throw new Error(
            `Thumbnail compositor returned ${composited.width}x${composited.height}; expected 1080x1920`,
          );
        }

        return {
          data: {
            sourceUrl: asset.url,
            imageUrl: composited.url,
            width: composited.width,
            height: composited.height,
            text: thumbnailText,
            textPosition,
            compositorVersion: compositor.version,
          },
          error: undefined,
        };
      } catch (err) {
        return {
          data: null,
          error: `${AgentModel.ThumbnailGenerator}: Image generation failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
    },
    config,
  );

  if (imageResult.error || !imageResult.data) {
    return {
      thumbnail: {},
      diagnostics: {
        errors: [imageResult.error ?? "Thumbnail image generation failed"],
        telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ThumbnailGenerator },
    };
  }

  return {
    thumbnail: {
      thumbnailPrompt: result.data.thumbnailPrompt,
      thumbnailText,
      textPosition,
      colorScheme: result.data.colorScheme,
      imageUrl: imageResult.data.imageUrl,
      generatedAt: new Date().toISOString(),
    },
    diagnostics: {
      telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
    },
    execution: { currentNode: AgentModel.ThumbnailGenerator },
  };
}
