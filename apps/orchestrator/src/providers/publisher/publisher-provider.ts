/**
 * Provider-agnostic publishing contract. The LangGraph layer, PublisherService,
 * and every non-YouTube provider deal only with these types; Google SDK
 * specifics live in `youtube/`.
 */

export type PrivacyStatus = "private" | "unlisted" | "public";

export interface PublishRequest {
  /** Local path to the final MP4 (real mode). */
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  /** Internal category label (e.g. "Education"), mapped per platform. */
  category: string;
  /** Local path to the thumbnail image, when one was generated. */
  thumbnailPath?: string;
  platform: string;

  publishAt?: string;
  privacyStatus: PrivacyStatus;

  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  language?: string;
  playlistIds?: string[];
}

/**
 * Resume an interrupted publication instead of publishing a new artifact.
 * `videoId` is the already-confirmed platform resource; playlist work is
 * skipped based on the state the provider persisted via call hooks.
 */
export interface ResumePublishRequest extends PublishRequest {
  videoId: string;
}

export interface PublishCallOptions {
  /**
   * Fired immediately after the platform confirms the uploaded artifact
   * (returns its ID), before any playlist/finalize work. This is the
   * idempotency boundary — the caller persists the ID here so a retry
   * resumes rather than re-uploading.
   */
  onUploaded?: (platformVideoId: string) => Promise<void> | void;
}

export interface PublishResult {
  platform: string;
  platformVideoId: string;
  url: string;
  status: "uploaded" | "published" | "scheduled" | "private";
  publishedAt: string;
}

export interface PublisherProvider {
  publish(
    request: PublishRequest,
    options?: PublishCallOptions,
  ): Promise<PublishResult>;
  /** Optional: continue an interrupted publication (idempotent resume). */
  resume?(
    request: ResumePublishRequest,
    options?: PublishCallOptions,
  ): Promise<PublishResult>;
}

/** Platform-agnostic failure taxonomy surfaced to the publication artifact. */
export interface PublishErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export class PublishError extends Error {
  readonly info: PublishErrorInfo;

  constructor(info: PublishErrorInfo) {
    super(info.message);
    this.name = "PublishError";
    this.info = info;
  }
}
