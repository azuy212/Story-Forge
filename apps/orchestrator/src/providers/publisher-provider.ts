export interface PublishOptions {
  videoUrl: string;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  category: string;
  thumbnailUrl: string;
  platform: string;
  scheduledAt?: string;
}

export interface PublishResult {
  platform: string;
  publishUrl: string;
  status: string;
  publishedAt: string;
}

export interface PublisherProvider {
  publish(opts: PublishOptions): Promise<PublishResult>;
}
