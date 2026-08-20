import { google } from "googleapis";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type GoogleAuthClient = InstanceType<typeof google.auth.OAuth2>;

/**
 * Single shared OAuth2 client factory for every Google API the orchestrator
 * talks to (YouTube upload, Sheets). Same credentials and refresh-token
 * handling everywhere; new scopes still require a one-time reauthorization
 * to issue a refresh token that carries them.
 */
export function createGoogleOAuthClient(
  config: GoogleOAuthConfig,
): GoogleAuthClient {
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
  );
  oauth2Client.setCredentials({ refresh_token: config.refreshToken });
  return oauth2Client;
}
