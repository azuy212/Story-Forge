import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProjectState } from "../../types/index.js";
import {
  getArtifactNamespace,
  getArtifactStore,
  getRunId,
} from "../../artifacts/context.js";
import type { ArtifactStore } from "../../artifacts/store.js";
import type {
  PublicationArtifact,
  PublicationStatus,
  PublicationsState,
} from "../../schemas/publication.js";
import {
  PublishError,
  type PublishCallOptions,
  type PublishErrorInfo,
  type PublisherProvider,
  type PublishRequest,
  type PublishResult,
} from "./publisher-provider.js";
import { createPublisherProvider } from "./registry.js";
import { getErrorMessage } from "../../utils/errors.js";

export interface PublishExecution {
  results: PublishResult[];
  errors: string[];
}

export interface PublishForPlatformsOptions {
  config: RunnableConfig;
  state: ProjectState;
  platforms: string[];
  request: Omit<PublishRequest, "platform">;
  /** Test/override provider; wins over the registry for every platform. */
  injectedProvider?: PublisherProvider;
}

export async function publishForPlatforms(
  opts: PublishForPlatformsOptions,
): Promise<PublishExecution> {
  const results: PublishResult[] = [];
  const errors: string[] = [];

  for (const platform of opts.platforms) {
    const provider = opts.injectedProvider ?? createPublisherProvider(platform);
    const request: PublishRequest = { ...opts.request, platform };
    try {
      const result = await publishToProvider({
        provider,
        request,
        config: opts.config,
        state: opts.state,
      });
      results.push(result);
    } catch (err) {
      errors.push(`${platform} publish failed: ${getErrorMessage(err)}`);
    }
  }

  return { results, errors };
}

async function publishToProvider(opts: {
  provider: PublisherProvider;
  request: PublishRequest;
  config: RunnableConfig;
  state: ProjectState;
}): Promise<PublishResult> {
  const { provider, request, config, state } = opts;
  const store = getArtifactStore(config);
  const runId = getRunId(config, state);

  // No artifact store / run key: no idempotency boundary exists, so publish
  // directly (stub and direct node invocations).
  if (!store || !runId) {
    return provider.publish(request);
  }

  const publicationId = `${getArtifactNamespace(config, state)}:${request.platform}`;

  const options: PublishCallOptions = {
    onUploaded: async (videoId) => {
      await updatePublication(store, runId, publicationId, request, {
        status: "uploaded",
        videoId,
        publishAt: request.publishAt,
        playlistIds: request.playlistIds,
        error: undefined,
      });
    },
    onThumbnailUploaded: async () => {
      await updatePublication(store, runId, publicationId, request, {
        thumbnailUploaded: true,
        error: undefined,
      });
    },
  };

  try {
    const existing = (await loadPublications(store, runId))[publicationId];

    if (existing?.status === "published") {
      return resultFromPublication(existing, request);
    }

    if (existing?.videoId) {
      // Resume: the platform already owns a video for this publication.
      await updatePublication(store, runId, publicationId, request, {
        status: "finalizing",
      });
      const resumed = provider.resume
        ? await provider.resume(
            {
              ...request,
              videoId: existing.videoId,
              thumbnailUploaded: existing.thumbnailUploaded,
            },
            options,
          )
        : await provider.publish(request, options);
      await updatePublication(store, runId, publicationId, request, {
        status: publicationStatusFromResult(resumed.status),
        videoId: resumed.platformVideoId,
        publishAt: request.publishAt,
        playlistIds: request.playlistIds,
        error: undefined,
      });
      return resumed;
    }

    await updatePublication(store, runId, publicationId, request, {
      status: "pending",
    });
    const result = await provider.publish(request, options);
    await updatePublication(store, runId, publicationId, request, {
      status: publicationStatusFromResult(result.status),
      videoId: result.platformVideoId,
      publishAt: request.publishAt,
      playlistIds: request.playlistIds,
      error: undefined,
    });
    return result;
  } catch (err) {
    // Thumbnail/playlist failures land here AFTER onUploaded persisted the
    // videoId, so a retry resumes rather than re-uploading (fail-closed:
    // the publication is marked failed, never silently partial).
    const existing = (await loadPublications(store, runId))[publicationId];
    await updatePublication(store, runId, publicationId, request, {
      status: "failed",
      error: toPublishErrorInfo(err),
      ...(existing?.videoId ? { videoId: existing.videoId } : {}),
    });
    throw err;
  }
}

function publicationStatusFromResult(
  status: PublishResult["status"],
): PublicationStatus {
  if (status === "scheduled") return "scheduled";
  if (status === "uploaded") return "uploaded";
  return "published";
}

function resultFromPublication(
  artifact: PublicationArtifact,
  request: PublishRequest,
): PublishResult {
  const videoId = artifact.videoId ?? "";
  return {
    platform: request.platform,
    platformVideoId: videoId,
    url: videoId ? `https://youtu.be/${videoId}` : "",
    status:
      artifact.status === "scheduled"
        ? "scheduled"
        : artifact.status === "uploaded"
          ? "uploaded"
          : "published",
    publishedAt: artifact.updatedAt,
  };
}

function toPublishErrorInfo(err: unknown): PublishErrorInfo {
  if (err instanceof PublishError) return err.info;
  return {
    code: "publish_failed",
    message: getErrorMessage(err),
    retryable: false,
  };
}

async function loadPublications(
  store: ArtifactStore,
  runId: string,
): Promise<PublicationsState> {
  const record = await store.latest<PublicationsState>(runId, "publication");
  if (!record?.data || typeof record.data !== "object") return {};
  return record.data;
}

async function updatePublication(
  store: ArtifactStore,
  runId: string,
  publicationId: string,
  request: PublishRequest,
  patch: Partial<PublicationArtifact>,
): Promise<void> {
  const current = await loadPublications(store, runId);
  const prev = current[publicationId];
  const now = new Date().toISOString();

  const artifact: PublicationArtifact = {
    ...prev,
    ...patch,
    publicationId,
    platform: request.platform,
    status: patch.status ?? prev?.status ?? "pending",
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };

  await store.save(
    runId,
    "publication",
    { ...current, [publicationId]: artifact },
    { inputHash: publicationId, runId },
    "complete",
  );
}
