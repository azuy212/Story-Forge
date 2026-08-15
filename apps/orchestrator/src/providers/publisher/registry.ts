import type { PublisherProvider } from "./publisher-provider.js";
import { StubPublisherProvider } from "./stub-publisher-provider.js";
import { createYouTubeProvider } from "./youtube/youtube-provider.js";

export type PublisherProviderFactory = () => PublisherProvider;

/**
 * Providers are lazy factories so credentials/config are only touched when a
 * platform is actually selected. YouTube falls back to the stub until
 * publishing is explicitly opted in (see createYouTubeProvider).
 */
export const publisherRegistry: ReadonlyMap<string, PublisherProviderFactory> =
  new Map<string, PublisherProviderFactory>([
    ["youtube", createYouTubeProvider],
  ]);

export function createPublisherProvider(platform: string): PublisherProvider {
  const factory = publisherRegistry.get(platform);
  if (!factory) return new StubPublisherProvider();
  return factory();
}
