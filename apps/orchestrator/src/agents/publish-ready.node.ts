import fs from "node:fs";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import type { PublishReadyStatus } from "../schemas/publish-ready.js";
import { config as configUtils } from "../utils/config.js";

export const PUBLISH_READY = "PublishReady";

const TITLE_MAX_CHARS = 100;
const DESCRIPTION_MAX_CHARS = 5000;
const TAGS_MAX_CHARS = 500;

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function hasPackage(state: ProjectState): boolean {
  return (
    !!state.video?.videoUrl &&
    !!state.metadataOutput?.title &&
    !!state.metadataOutput?.description &&
    (state.metadataOutput?.tags?.length ?? 0) > 0 &&
    !!state.thumbnail?.imageUrl
  );
}

/**
 * PublishReady is the explicit join/barrier before Publisher. LangGraph
 * triggers a fan-in node when ANY incoming edge fires — not when all of them
 * do — so this node may run several times as branches complete (once after
 * Metadata/Thumbnail, again after the spine). It therefore records nothing for
 * a partial package: that is the expected intermediate state while the slower
 * spine is still running.
 *
 * When the full package IS present it acts as a hard operational gate: cheap
 * existence/length/credentials checks only. Technical validation (media
 * streams, subtitles, timing) belongs to ReleaseValidation; PublishReady
 * never probes media. A blocked verdict writes publishReady.status=blocked so
 * the graph's conditional edge falls through to __end__ and Publisher never
 * fires on an unpublishable artifact.
 */
export async function publishReadyNode(state: ProjectState): Promise<{
  publishReady: Partial<PublishReadyStatus>;
  execution: Partial<Execution>;
  diagnostics: Partial<Diagnostics>;
}> {
  if (!hasPackage(state)) {
    return {
      publishReady: {},
      execution: { currentNode: PUBLISH_READY },
      diagnostics: {},
    };
  }

  const problems: string[] = [];
  const video = state.video!.videoUrl!;
  const thumbnail = state.thumbnail!.imageUrl!;
  const meta = state.metadataOutput!;
  const platforms = state.branding?.platforms ?? ["youtube"];

  if (video.length === 0) {
    problems.push("Final video missing");
  } else if (!isHttpUrl(video) && !fs.existsSync(video)) {
    problems.push(`Final video file missing: ${video}`);
  }

  if (thumbnail.length === 0) {
    problems.push("Thumbnail missing");
  } else if (!isHttpUrl(thumbnail) && !fs.existsSync(thumbnail)) {
    problems.push(`Thumbnail file missing: ${thumbnail}`);
  }

  if ((meta.title?.length ?? 0) > TITLE_MAX_CHARS) {
    problems.push(
      `Title exceeds ${TITLE_MAX_CHARS} characters (${meta.title!.length})`,
    );
  }
  if ((meta.description?.length ?? 0) > DESCRIPTION_MAX_CHARS) {
    problems.push(
      `Description exceeds ${DESCRIPTION_MAX_CHARS} characters (${meta.description!.length})`,
    );
  }
  const tagChars = [...(meta.tags ?? []), ...(meta.hashtags ?? [])].reduce(
    (total, tag) => total + tag.length + 1,
    0,
  );
  if (tagChars > TAGS_MAX_CHARS) {
    problems.push(
      `Combined tags exceed ${TAGS_MAX_CHARS} characters (${tagChars})`,
    );
  }

  const publishAt = configUtils.youtubePublishAt(state);
  if (publishAt) {
    if (configUtils.youtubePrivacyStatus() !== "private") {
      problems.push('publishAt requires privacyStatus "private"');
    } else if (Number.isNaN(new Date(publishAt).getTime())) {
      problems.push("publishAt is not a valid date");
    }
  }

  if (
    platforms.includes("youtube") &&
    configUtils.useRealProviders() &&
    configUtils.youtubePublishingEnabled()
  ) {
    if (
      !configUtils.youtubeClientId() ||
      !configUtils.youtubeClientSecret() ||
      !configUtils.youtubeRefreshToken()
    ) {
      problems.push(
        "YouTube credentials missing (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN)",
      );
    }
  }

  if (problems.length > 0) {
    return {
      publishReady: { status: "blocked", issues: problems },
      execution: { currentNode: PUBLISH_READY },
      diagnostics: {
        errors: problems.map((issue) => `${PUBLISH_READY}: ${issue}`),
      },
    };
  }

  return {
    publishReady: { status: "ready", issues: [] },
    execution: { currentNode: PUBLISH_READY },
    diagnostics: {},
  };
}
