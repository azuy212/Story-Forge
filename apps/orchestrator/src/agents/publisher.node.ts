import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Diagnostics,
  Execution,
  Publishing,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import type { PublisherProvider } from "../providers/publisher/publisher-provider.js";
import { publishForPlatforms } from "../providers/publisher/publisher-service.js";
import { syncPublishResults } from "../integrations/google-sheets/sync.js";
import type { SheetsValuesApi } from "../integrations/google-sheets/client.js";
import { cacheNodeResult } from "../artifacts/cache.js";
import { withTopic } from "../artifacts/context.js";
import type { SourceAsset } from "../schemas/production.js";
import { config as configUtils } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";

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

function getInjectedProvider(
  config: RunnableConfig,
): PublisherProvider | undefined {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return inject.publisherProvider as PublisherProvider | undefined;
}

function getInjectedSheetsApi(
  config: RunnableConfig,
): SheetsValuesApi | undefined {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return inject.sheetsApi as SheetsValuesApi | undefined;
}

export async function publisherNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  publishing: Partial<Publishing>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const startedAt = Date.now();
  const videoPath = state.video?.videoUrl;
  const title = state.metadataOutput?.title;
  const description = `${state.metadataOutput?.description ?? ""}${sourceCredits(state)}`;
  const tags = state.metadataOutput?.tags ?? [];
  const hashtags = state.metadataOutput?.hashtags ?? [];
  const category = state.metadataOutput?.category ?? "";
  const thumbnailPath = state.thumbnail?.imageUrl ?? "";
  const platforms = state.branding?.platforms ?? ["youtube"];
  const label = nodeLabel(AgentModel.Publisher);
  logger.nodeStart(label);

  // Publisher only runs after the PublishReady join/barrier, which gates it on
  // every release prerequisite (video + metadata + thumbnail). The checks below
  // are therefore defensive only — a missing artifact here means a guard or the
  // PublishReady gate was bypassed. Publisher must not invent its own
  // "videoUrl is missing" error on top of the already-recorded upstream one.
  if (!videoPath) {
    return {
      publishing: {},
      diagnostics: {},
      execution: { currentNode: AgentModel.Publisher },
    };
  }

  if (!title) {
    logger.nodeFailed(label, "metadata title is missing");
    return {
      publishing: { results: [] },
      diagnostics: {
        errors: [`${AgentModel.Publisher}: metadata title is missing`],
      },
      execution: { currentNode: AgentModel.Publisher },
    };
  }

  const publishAt = configUtils.youtubePublishAt(state);
  const privacyStatus = configUtils.youtubePrivacyStatus();
  if (publishAt && privacyStatus !== "private") {
    logger.nodeFailed(label, 'publishAt requires privacyStatus "private"');
    return {
      publishing: { results: [] },
      diagnostics: {
        errors: [
          `${AgentModel.Publisher}: publishAt requires privacyStatus "private"`,
        ],
      },
      execution: { currentNode: AgentModel.Publisher },
    };
  }

  const request = {
    videoPath,
    title,
    description,
    tags,
    hashtags,
    category,
    thumbnailPath: thumbnailPath || undefined,
    publishAt,
    privacyStatus,
    madeForKids: configUtils.youtubeMadeForKids(),
    containsSyntheticMedia: configUtils.youtubeContainsSyntheticMedia(),
    language: configUtils.youtubeLanguage(),
    playlistIds: configUtils.youtubePlaylistIds(),
  };

  const provider = getInjectedProvider(config);

  logger.nodePhase(label, "uploading video");

  const result = await cacheNodeResult<Partial<Publishing>>(
    {
      type: "publish",
      node: AgentModel.Publisher,
      key: {
        provider: provider?.constructor.name ?? "registry",
        ...request,
      },
      // Legacy artifacts may hold partial results (some platforms failed).
      // Only a complete publish for every requested platform is a valid hit.
      validate: (artifact) =>
        Array.isArray(artifact.results) &&
        artifact.results.length === platforms.length,
    },
    async () => {
      const execution = await publishForPlatforms({
        config,
        state,
        platforms,
        request,
        injectedProvider: provider,
      });

      if (execution.errors.length > 0) {
        const succeeded = execution.results.map((r) => r.platform);
        const note =
          succeeded.length > 0 ? `\nSucceeded: ${succeeded.join(", ")}` : "";
        return { data: null, error: `${execution.errors.join("\n")}${note}` };
      }

      return {
        data: {
          results: execution.results,
          publishedAt: new Date().toISOString(),
        },
      };
    },
    withTopic(config, state),
  );

  if (result.error) {
    logger.nodeFailed(label, result.error);
  } else {
    logger.nodeDone(label, Date.now() - startedAt);
  }

  // Best-effort write-back of publish records to Google Sheets. Never throws
  // and never fails the publish; the sync itself logs its own failures.
  if (result.data) {
    await syncPublishResults({
      state,
      results: result.data.results ?? [],
      publishAt: publishAt ?? undefined,
      api: getInjectedSheetsApi(config),
    });
  }

  return {
    publishing: result.data ?? { results: [] },
    diagnostics: {
      errors: result.error ? [result.error] : undefined,
    },
    execution: { currentNode: AgentModel.Publisher },
  };
}
