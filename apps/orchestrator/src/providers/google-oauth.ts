import { config } from "../utils/config.js";

type FetchLike = typeof fetch;

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export class GoogleOAuthRefreshTokenProvider implements AccessTokenProvider {
  private accessToken?: string;
  private expiresAt = 0;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly credentials: {
      clientId?: string;
      clientSecret?: string;
      refreshToken?: string;
    } = {
      clientId: config.googleClientId(),
      clientSecret: config.googleClientSecret(),
      refreshToken: config.googleRefreshToken(),
    },
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
      return this.accessToken;
    }

    const { clientId, clientSecret, refreshToken } = this.credentials;
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.",
      );
    }

    const response = await this.fetchImpl(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      },
    );
    const body = (await response.json()) as TokenResponse;
    if (!response.ok || !body.access_token) {
      const detail =
        body.error_description ?? body.error ?? response.statusText;
      throw new Error(`Google OAuth token refresh failed: ${detail}`);
    }

    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}
