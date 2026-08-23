import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Publishing,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import type { PublisherProvider } from "../providers/publisher-provider.js";
import { StubPublisherProvider } from "../providers/stub-publisher-provider.js";
import { YouTubePublisherProvider } from "../providers/youtube-publisher-provider.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { getErrorMessage } from "../utils/errors.js";
import type { SourceAsset } from "../schemas/production.js";
import { config as appConfig } from "../utils/config.js";
import type { StorySource } from "../providers/story-source.js";
import { GoogleSheetsStorySource } from "../providers/google-sheets-story-source.js";

const DEFAULT_PROVIDER = new StubPublisherProvider();
let youtubeProvider: YouTubePublisherProvider | undefined;

function sourceCredits(state: ProjectState): string {
  const scenes = state.production?.scenes ?? [];
  const assets = state.production?.sourceAssets ?? [];
  const usedIds = new Set(
    scenes.flatMap((scene) => scene.sourceAssetIds ?? []),
  );
  const usedAssets = assets.filter((asset) => usedIds.has(asset.id));
  if (usedAssets.length === 0) return "";

  const lines = usedAssets.map((asset: SourceAsset) => {
    const label =
      asset.title?.trim() || asset.attribution?.trim() || asset.source;
    const sourceUrl = asset.sourcePageUrl ?? asset.url;
    const license = asset.license
      ? ` (${asset.license}${asset.licenseUrl ? `: ${asset.licenseUrl}` : ""})`
      : "";
    return `- ${label}: ${sourceUrl}${license}`;
  });
  return `\n\nSource credits:\n${lines.join("\n")}`;
}

function getPublisherProvider(config: RunnableConfig): PublisherProvider {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  if (inject.publisherProvider) {
    return inject.publisherProvider as PublisherProvider;
  }
  if (appConfig.useRealProviders() && appConfig.youtubeUploadEnabled()) {
    youtubeProvider ??= new YouTubePublisherProvider();
    return youtubeProvider;
  }
  return DEFAULT_PROVIDER;
}

function getStorySource(config: RunnableConfig): StorySource | undefined {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  if (inject.storySource) return inject.storySource as StorySource;
  return appConfig.storySheetEnabled()
    ? new GoogleSheetsStorySource()
    : undefined;
}

async function recordYoutubeEditUrl(
  state: ProjectState,
  publishing: Partial<Publishing> | null,
  config: RunnableConfig,
): Promise<string | undefined> {
  const youtube = publishing?.results?.find(
    (item) => item.platform.toLocaleLowerCase() === "youtube",
  );
  if (!youtube) return undefined;

  const threadId = state.project?.projectId ?? state.execution?.runId;
  const storySource = getStorySource(config);
  if (!threadId || !storySource) return undefined;

  try {
    await storySource.recordYoutubeEditUrl(threadId, youtube.publishUrl);
    return undefined;
  } catch (error) {
    return `${AgentModel.Publisher}: YouTube uploaded, but saving its edit URL to the story sheet failed: ${getErrorMessage(error)}`;
  }
}

export async function publisherNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  publishing: Partial<Publishing>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const videoUrl = state.video?.videoUrl;
  const title = state.metadataOutput?.title;
  const description = `${state.metadataOutput?.description ?? ""}${sourceCredits(state)}`;
  const tags = state.metadataOutput?.tags ?? [];
  const hashtags = state.metadataOutput?.hashtags ?? [];
  const category = state.metadataOutput?.category ?? "";
  const thumbnailUrl = state.thumbnail?.imageUrl ?? "";
  const platforms = state.branding?.platforms ?? ["youtube"];

  // Publisher only runs after the PublishReady join/barrier, which gates it on
  // every release prerequisite (video + metadata + thumbnail). The checks below
  // are therefore defensive only — a missing artifact here means a guard or the
  // PublishReady gate was bypassed. Publisher must not invent its own
  // "videoUrl is missing" error on top of the already-recorded upstream one.
  if (!videoUrl) {
    return {
      publishing: {},
      diagnostics: {},
      execution: { currentNode: AgentModel.Publisher },
    };
  }

  if (!title) {
    return {
      publishing: { results: [] },
      diagnostics: {
        errors: [`${AgentModel.Publisher}: metadata title is missing`],
      },
      execution: { currentNode: AgentModel.Publisher },
    };
  }

  const provider = getPublisherProvider(config);

  const result = await cacheNodeResult<Partial<Publishing>>(
    {
      type: "publish",
      node: AgentModel.Publisher,
      key: {
        provider: provider.constructor.name,
        videoUrl,
        title,
        description,
        tags,
        hashtags,
        category,
        thumbnailUrl,
        platforms,
      },
      // Legacy artifacts may hold partial results (some platforms failed).
      // Only a complete publish for every requested platform is a valid hit.
      validate: (artifact) =>
        Array.isArray(artifact.results) &&
        artifact.results.length === platforms.length,
    },
    async () => {
      const settled = await Promise.allSettled(
        platforms.map((platform) =>
          provider.publish({
            videoUrl,
            title,
            description,
            tags,
            hashtags,
            category,
            thumbnailUrl,
            platform,
          }),
        ),
      );

      const results: Publishing["results"] = [];
      const errors: string[] = [];
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
          errors.push(
            `${AgentModel.Publisher}: Publish to ${platforms[i]} failed: ${getErrorMessage(s.reason)}`,
          );
        }
      });

      // Fail-closed: a partial publish is never cached as success. Returning
      // data:null skips caching, so a retry re-attempts the failed platforms
      // and diagnostics keep the error instead of silently looking clean.
      if (errors.length > 0) {
        const succeeded = results.map((r) => r.platform);
        const note =
          succeeded.length > 0 ? `\nSucceeded: ${succeeded.join(", ")}` : "";
        return { data: null, error: `${errors.join("\n")}${note}` };
      }

      return {
        data: {
          results,
          publishedAt: new Date().toISOString(),
        },
      };
    },
    config,
  );

  const sheetError = result.error
    ? undefined
    : await recordYoutubeEditUrl(state, result.data, config);
  const finalError = result.error ?? sheetError;

  return {
    publishing: result.data ?? { results: [] },
    diagnostics: {
      errors: finalError ? [finalError] : undefined,
    },
    execution: {
      currentNode: AgentModel.Publisher,
      status: finalError ? "failed" : "completed",
      finishedAt: new Date().toISOString(),
    },
  };
}
