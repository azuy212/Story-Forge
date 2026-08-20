import { google } from "googleapis";
import {
  createGoogleOAuthClient,
  type GoogleAuthClient,
} from "../../providers/google/google-oauth.js";
import { config } from "../../utils/config.js";

/**
 * Narrow surface of the Sheets v4 values API the integration uses. Kept as a
 * small interface (mirroring the loose `YouTubeApi` in youtube-client.ts) so
 * tests inject a fake instead of mocking googleapis.
 */
export interface SheetsValuesApi {
  get(params: {
    spreadsheetId: string;
    range: string;
  }): Promise<{ data: { values?: (string | number | boolean)[][] } }>;
  update(params: {
    spreadsheetId: string;
    range: string;
    valueInputOption: string;
    requestBody: { values: (string | number | boolean)[][] };
  }): Promise<{ data: unknown }>;
  append(params: {
    spreadsheetId: string;
    range: string;
    valueInputOption: string;
    insertDataOption: string;
    requestBody: { values: (string | number | boolean)[][] };
  }): Promise<{ data: unknown }>;
}

export function createSheetsClient(auth: GoogleAuthClient): SheetsValuesApi {
  const sheets = google.sheets({ version: "v4", auth });
  return {
    get: (params) =>
      sheets.spreadsheets.values.get(params) as Promise<{
        data: { values?: (string | number | boolean)[][] };
      }>,
    update: (params) =>
      sheets.spreadsheets.values.update(params) as Promise<{ data: unknown }>,
    append: (params) =>
      sheets.spreadsheets.values.append(params) as Promise<{ data: unknown }>,
  };
}

/**
 * Build a Sheets client from the shared YouTube OAuth credentials. Used by the
 * publisher node; the `run-next.mjs` CLI builds its own client directly from
 * env (it cannot import TS).
 */
export function createSheetsClientFromConfig(): SheetsValuesApi {
  const auth = createGoogleOAuthClient({
    clientId: config.youtubeClientId(),
    clientSecret: config.youtubeClientSecret(),
    refreshToken: config.youtubeRefreshToken(),
  });
  return createSheetsClient(auth);
}
