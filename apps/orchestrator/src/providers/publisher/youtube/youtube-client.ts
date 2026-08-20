import { google } from "googleapis";
import { createGoogleOAuthClient } from "../../google/google-oauth.js";

/**
 * The only files that import googleapis are this one and the shared OAuth
 * factory. Everything above this layer deals with domain objects. The
 * interface is intentionally loose so tests can inject a fake client without
 * jest.mock.
 */

export interface YouTubeVideoInsertResult {
  data: { id?: string };
}

export interface YouTubeApi {
  videos: {
    insert(
      params: Record<string, unknown>,
      options?: { onUploadProgress?: (progress: unknown) => void },
    ): Promise<YouTubeVideoInsertResult>;
  };
  playlistItems: {
    insert(params: Record<string, unknown>): Promise<{ data: unknown }>;
  };
}

export interface YouTubeClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function createYouTubeApi(config: YouTubeClientConfig): YouTubeApi {
  const auth = createGoogleOAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
  });

  return google.youtube({
    version: "v3",
    auth,
  }) as unknown as YouTubeApi;
}

export function isUsableYouTubeApi(api: YouTubeApi): boolean {
  return typeof api?.videos?.insert === "function";
}
