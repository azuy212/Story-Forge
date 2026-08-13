import type {
  PublisherProvider,
  PublishRequest,
  PublishResult,
  ResumePublishRequest,
} from "./publisher-provider.js";

export class StubPublisherProvider implements PublisherProvider {
  async publish(request: PublishRequest): Promise<PublishResult> {
    const id = "video-001";
    return {
      platform: request.platform,
      platformVideoId: id,
      url: `https://placeholder.local/${request.platform}/${id}`,
      status: "published",
      publishedAt: new Date().toISOString(),
    };
  }

  async resume(request: ResumePublishRequest): Promise<PublishResult> {
    return {
      platform: request.platform,
      platformVideoId: request.videoId,
      url: `https://placeholder.local/${request.platform}/${request.videoId}`,
      status: "published",
      publishedAt: new Date().toISOString(),
    };
  }
}
