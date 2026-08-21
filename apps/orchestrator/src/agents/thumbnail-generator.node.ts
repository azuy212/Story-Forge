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
import { runAgent, type AgentInject, type AgentResult } from "./run-agent.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ThumbnailOutputSchema } from "../schemas/thumbnail-output.js";
import type { ThumbnailOutput } from "../schemas/thumbnail-output.js";
import type { AssetProvider } from "../providers/asset-provider.js";
import { createDefaultAssetProvider } from "../providers/asset-provider.js";
import {
  cacheNodeResult,
  completeArtifactForNode,
} from "../artifacts/cache.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import { getArtifactNamespace, withTopic } from "../artifacts/context.js";
import { config as envConfig } from "../utils/config.js";
import { getErrorMessage } from "../utils/errors.js";
import type {
  ThumbnailCompositor,
  ThumbnailTextPosition,
} from "../providers/thumbnail-compositor.js";
import {
  createDefaultThumbnailCompositor,
  normalizeTextPosition,
} from "../providers/thumbnail-compositor.js";
import { runThumbnailQa, type ThumbnailQaResult } from "./thumbnail-qa.node.js";
import type { ThumbnailFallbackReason } from "../schemas/thumbnail-qa.js";

const DEFAULT_PROVIDER = createDefaultAssetProvider();
const DEFAULT_COMPOSITOR = createDefaultThumbnailCompositor();

const TEXT_POSITION_HINT: Record<ThumbnailTextPosition, string> = {
  "bottom-third": "bottom third of the frame",
  "top-left": "top-left corner region",
  "top-right": "top-right corner region",
  center: "central horizontal band across the middle of the frame",
};

export type ThumbnailRenderMode = "full" | "overlay";

/**
 * Append authoritative layout instructions to the LLM-generated thumbnail
 * prompt.
 *
 * - overlay: the image model leaves the text area clean and never renders text;
 *   the deterministic FFmpeg compositor draws the text.
 * - full: the image model renders the complete thumbnail INCLUDING the exact
 *   title as integrated cinematic typography. The model chooses placement; no
 *   fixed bottom area is reserved.
 */
export function buildGenerationPrompt(
  thumbnailPrompt: string,
  thumbnailText: string,
  textPosition: ThumbnailTextPosition,
  mode: ThumbnailRenderMode,
): string {
  if (mode === "full") {
    return [
      thumbnailPrompt,
      "",
      "PIPELINE TYPOGRAPHY NOTE (authoritative, follow exactly):",
      `- Render the exact text "${thumbnailText}" as large, cinematic, high-contrast typography integrated into the composition.`,
      `- The text MUST appear exactly as given: "${thumbnailText}".`,
      "- Render NO other text, letters, words, numbers, watermarks, or logos anywhere in the image.",
      "- The title must be large and instantly readable on a small mobile screen.",
      "- Choose the title placement based on the composition; do NOT reserve a fixed bottom strip that would weaken the focal subject.",
      "- The subject and the title must not overlap in an awkward way, but both share the frame as one composition.",
      "- Keep the focal subject and the title away from the extreme edges.",
      "- Output a vertical 9:16 image at 1080x1920 pixels.",
    ].join("\n");
  }
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

function getThumbnailQa(
  config: RunnableConfig,
): (imagePath: string, thumbnailText: string) => Promise<ThumbnailQaResult> {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (
    (inject.thumbnailQa as (
      imagePath: string,
      thumbnailText: string,
    ) => Promise<ThumbnailQaResult>) ??
    ((imagePath, thumbnailText) =>
      runThumbnailQa(imagePath, thumbnailText, config))
  );
}

/**
 * Append authoritative layout instructions to the LLM-generated thumbnail
 * prompt. The image model is told to leave the text area clean and to never
 * render text itself; the deterministic FFmpeg compositor is the only thing
 * that draws the thumbnail text.
 */
export async function thumbnailGeneratorNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  thumbnail: Partial<Thumbnail>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const startedAt = Date.now();
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

  const label = nodeLabel(AgentModel.ThumbnailGenerator);
  logger.nodeStart(label);
  logger.nodePhase(label, "generating thumbnail prompt");

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
    configurable: withTopic(config, state).configurable,
    generateOptions: {
      temperature: 0.6,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    logger.nodeFailed(label, result.error ?? "Unknown LLM error");
    return {
      thumbnail: {},
      diagnostics: {
        errors: [`${AgentModel.ThumbnailGenerator}: ${result.error}`],
        telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ThumbnailGenerator },
    };
  }

  logger.nodePhase(label, "generating thumbnail image");
  const provider = getAssetProvider(config);
  const compositor = getThumbnailCompositor(config);
  const runId = getArtifactNamespace(config, state);

  const output = result.data;
  const thumbnailText = output.thumbnailText.trim();
  const textPosition = normalizeTextPosition(output.textPosition);
  const colorScheme = output.colorScheme;
  const mode = envConfig.thumbnailMode();
  const qaEnabled = envConfig.thumbnailQaEnabled();
  const qaModel = envConfig.thumbnailQaModel();

  // Generate thumbnail without caching - used for full mode where caching
  // happens only after QA passes.
  async function generateThumbnail(renderMode: ThumbnailRenderMode): Promise<{
    data: ThumbnailImageOutput | null;
    error?: string;
  }> {
    const generationPrompt = buildGenerationPrompt(
      output.thumbnailPrompt,
      thumbnailText,
      textPosition,
      renderMode,
    );

    try {
      const asset = await provider.generateImage({
        prompt: generationPrompt,
        sceneId: 0,
        filename: "thumbnail.png",
        runId,
      });

      const compositeText = renderMode === "full" ? "" : thumbnailText;
      const composited = await compositor.composite({
        sourceUrl: asset.url,
        text: compositeText,
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
          mode: renderMode,
          fallbackReason: undefined,
        },
        error: undefined,
      };
    } catch (err) {
      return {
        data: null,
        error: `${AgentModel.ThumbnailGenerator}: Image generation failed: ${(err as Error)?.message ?? String(err)}`,
      };
    }
  }

  // Cached render for the deterministic overlay pipeline. Overlay output is
  // always the compositor's text-on-image; QA never participates, so the
  // cache key carries no QA fields.
  async function cachedRender(renderMode: ThumbnailRenderMode): Promise<{
    data: ThumbnailImageOutput | null;
    error?: string;
  }> {
    const generationPrompt = buildGenerationPrompt(
      output.thumbnailPrompt,
      thumbnailText,
      textPosition,
      renderMode,
    );

    return cacheNodeResult<ThumbnailImageOutput>(
      {
        type: "thumbnailImage",
        node: "ThumbnailCompositor",
        key: {
          prompt: generationPrompt,
          thumbnailText,
          textPosition,
          renderMode,
          compositor: compositor.fingerprint(),
          provider: provider.constructor.name,
        },
        validate: isUsableThumbnailImage,
      },
      async () => generateThumbnail(renderMode),
      withTopic(config, state),
    );
  }

  // overlay: deterministic pipeline text, no QA needed.
  if (mode === "overlay") {
    const imageResult = await cachedRender("overlay");
    if (imageResult.error || !imageResult.data) {
      logger.nodeFailed(
        label,
        imageResult.error ?? "Thumbnail image generation failed",
      );
      return {
        thumbnail: {},
        diagnostics: {
          errors: [imageResult.error ?? "Thumbnail image generation failed"],
          telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
        },
        execution: { currentNode: AgentModel.ThumbnailGenerator },
      };
    }
    logger.nodeDone(label, Date.now() - startedAt);
    return buildSuccess(
      imageResult.data,
      output,
      thumbnailText,
      textPosition,
      result.telemetry,
    );
  }

  const fullPrompt = buildGenerationPrompt(
    output.thumbnailPrompt,
    thumbnailText,
    textPosition,
    "full",
  );

  // Full mode always requires QA. Auto mode respects THUMBNAIL_QA.
  const effectiveQaEnabled = mode === "full" ? true : qaEnabled;
  if (!effectiveQaEnabled) {
    // Only auto mode with THUMBNAIL_QA=false reaches here: no QA, so no
    // caching - an unverified thumbnail must never be reused.
    const fullResult = await generateThumbnail("full");
    if (fullResult.error || !fullResult.data) {
      logger.nodeFailed(
        label,
        fullResult.error ?? "Thumbnail image generation failed",
      );
      return {
        thumbnail: {},
        diagnostics: {
          errors: [fullResult.error ?? "Thumbnail image generation failed"],
          telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
        },
        execution: { currentNode: AgentModel.ThumbnailGenerator },
      };
    }
    logger.nodeDone(label, Date.now() - startedAt);
    return buildSuccess(
      fullResult.data,
      output,
      thumbnailText,
      textPosition,
      result.telemetry,
    );
  }

  // Cache lookup first: a complete artifact was QA-passed (with the same QA
  // model) on a prior run, so generation and QA can be skipped entirely.
  // Fresh renders are saved "pending" and only completed once QA passes, so a
  // QA-failed thumbnail is never servable from cache.
  const cached = await cacheNodeResult<ThumbnailImageOutput>(
    {
      type: "thumbnailImage",
      node: "ThumbnailCompositor",
      deferComplete: true,
      key: {
        prompt: fullPrompt,
        thumbnailText,
        textPosition,
        renderMode: "full",
        qaEnabled: true,
        qaModel,
        compositor: compositor.fingerprint(),
        provider: provider.constructor.name,
      },
      validate: isUsableThumbnailImage,
    },
    async () => generateThumbnail("full"),
    withTopic(config, state),
  );

  if (cached.fromCache) {
    logger.nodeDone(label, Date.now() - startedAt);
    return buildSuccess(
      cached.data!,
      output,
      thumbnailText,
      textPosition,
      result.telemetry,
    );
  }
  if (cached.error || !cached.data) {
    logger.nodeFailed(
      label,
      cached.error ?? "Thumbnail image generation failed",
    );
    return {
      thumbnail: {},
      diagnostics: {
        errors: [cached.error ?? "Thumbnail image generation failed"],
        telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ThumbnailGenerator },
    };
  }

  let qa: ThumbnailQaResult | undefined;
  let qaUnavailableError: string | undefined;

  logger.nodePhase(label, "validating thumbnail");

  try {
    qa = await getThumbnailQa(config)(cached.data.imageUrl, thumbnailText);
  } catch (err) {
    // QA infrastructure failure: in full mode this is a hard failure.
    // In auto mode we fall back to overlay.
    if (mode === "full") {
      logger.nodeFailed(
        label,
        `Full-mode thumbnail QA failed: ${getErrorMessage(err)}`,
      );
      return {
        thumbnail: {},
        diagnostics: {
          errors: [
            `${AgentModel.ThumbnailGenerator}: Full-mode thumbnail QA failed: ${getErrorMessage(err)}`,
          ],
          telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
        },
        execution: { currentNode: AgentModel.ThumbnailGenerator },
      };
    }
    qaUnavailableError = getErrorMessage(err);
  }

  if (qa?.status === "pass") {
    // Pending render now verified - make it servable from cache.
    await completeArtifactForNode(config, "ThumbnailCompositor", state);
    logger.nodeDone(label, Date.now() - startedAt);
    return buildSuccess(
      cached.data,
      output,
      thumbnailText,
      textPosition,
      result.telemetry,
    );
  }

  if (mode === "full") {
    // qa is defined here because qaUnavailableError would have returned early
    logger.nodeFailed(
      label,
      `Full-mode thumbnail failed QA: ${qa!.issues.join("; ")}`,
    );
    return {
      thumbnail: {},
      diagnostics: {
        errors: [
          `${AgentModel.ThumbnailGenerator}: Full-mode thumbnail failed QA: ${qa!.issues.join("; ")}`,
        ],
        telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ThumbnailGenerator },
    };
  }

  // auto mode: fall back to the reliable overlay pipeline. Distinguish a
  // rejected thumbnail from an unavailable QA provider - operationally
  // different when inspecting production fallbacks.
  const fallbackReason: ThumbnailFallbackReason = qaUnavailableError
    ? { code: "thumbnail_qa_unavailable", issues: [qaUnavailableError] }
    : { code: "thumbnail_qa_failed", issues: qa!.issues };
  const overlayResult = await cachedRender("overlay");
  if (overlayResult.error || !overlayResult.data) {
    logger.nodeFailed(
      label,
      overlayResult.error ?? "Thumbnail image generation failed",
    );
    return {
      thumbnail: {},
      diagnostics: {
        errors: [overlayResult.error ?? "Thumbnail image generation failed"],
        telemetry: { [AgentModel.ThumbnailGenerator]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ThumbnailGenerator },
    };
  }
  // Attach fallbackReason to the image output for this run (not cached).
  const imageWithFallback: ThumbnailImageOutput = {
    ...overlayResult.data,
    fallbackReason,
  };
  const result2 = buildSuccess(
    imageWithFallback,
    output,
    thumbnailText,
    textPosition,
    result.telemetry,
  );
  logger.nodeDone(label, Date.now() - startedAt);
  return result2;
}

function buildSuccess(
  image: ThumbnailImageOutput,
  output: ThumbnailOutput,
  thumbnailText: string,
  textPosition: string,
  telemetry: AgentResult<ThumbnailOutput>["telemetry"],
): {
  thumbnail: Partial<Thumbnail>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
} {
  return {
    thumbnail: {
      thumbnailPrompt: output.thumbnailPrompt,
      thumbnailText,
      textPosition,
      colorScheme: output.colorScheme,
      imageUrl: image.imageUrl,
      mode: image.mode,
      fallbackReason: image.fallbackReason,
      generatedAt: new Date().toISOString(),
    },
    diagnostics: {
      telemetry: { [AgentModel.ThumbnailGenerator]: telemetry },
    },
    execution: { currentNode: AgentModel.ThumbnailGenerator },
  };
}
