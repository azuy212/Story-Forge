import { google } from "googleapis";

/**
 * The only file that imports googleapis. Everything above this layer deals
 * with domain objects. The interface is intentionally loose so tests can
 * inject a fake client without jest.mock.
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
  thumbnails: {
    set(params: Record<string, unknown>): Promise<{ data: unknown }>;
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
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
  );
  oauth2Client.setCredentials({ refresh_token: config.refreshToken });

  return google.youtube({
    version: "v3",
    auth: oauth2Client,
  }) as unknown as YouTubeApi;
}

export function isUsableYouTubeApi(api: YouTubeApi): boolean {
  return typeof api?.videos?.insert === "function";
}
