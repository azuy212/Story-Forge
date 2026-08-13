/**
 * One-time interactive OAuth setup for the publisher service. The server
 * never runs this flow: a human authenticates once, captures the refresh
 * token, and the pipeline reuses it (googleapis auto-refreshes access
 * tokens). See scripts/oauth-youtube.mjs for the CLI wrapper.
 */

import { google } from "googleapis";

export interface OAuthSetupConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
}

export const YOUTUBE_UPLOAD_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
];

export function buildConsentUrl(config: OAuthSetupConfig): string {
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri,
  );
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: config.scopes ?? YOUTUBE_UPLOAD_SCOPES,
  });
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiryDate: number | null;
}

export async function exchangeCodeForTokens(
  config: OAuthSetupConfig,
  code: string,
): Promise<TokenExchangeResult> {
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    config.redirectUri,
  );
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token returned. Ensure 'prompt=consent' and 'access_type=offline'.",
    );
  }
  return {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date ?? null,
  };
}
