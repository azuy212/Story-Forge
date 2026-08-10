import type { PublisherProvider, PublishOptions, PublishResult } from "./publisher-provider.js";

export class StubPublisherProvider implements PublisherProvider {
  async publish(opts: PublishOptions): Promise<PublishResult> {
    return {
      platform: opts.platform,
      publishUrl: `https://placeholder.local/${opts.platform}/video-001`,
      status: "published",
      publishedAt: new Date().toISOString(),
    };
  }
}
