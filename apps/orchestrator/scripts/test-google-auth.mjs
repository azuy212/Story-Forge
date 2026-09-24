#!/usr/bin/env node
// Google OAuth diagnostic: refresh an access token via the normal
// google-auth-library path (OAuth2Client.getAccessToken).
//
// Requires YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
// in apps/orchestrator/.env. Never prints secrets.
//
// Usage:
//   pnpm exec node apps/orchestrator/scripts/test-google-auth.mjs

import "../src/runtime/network.mjs";

import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import googleapis from "googleapis";
import { getNetworkRuntimeState } from "../src/runtime/network.mjs";

const { google } = googleapis;

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
dotenv.config({ path: envPath, quiet: true });

function section(title) {
  console.log(title);
  console.log("-".repeat(title.length));
}

async function main() {
  section("Google OAuth diagnostic");

  const runtime = getNetworkRuntimeState();
  console.log(`DNS result order: ${runtime.dnsResultOrder}`);
  console.log(`Auto-select family: ${runtime.autoSelectFamily}`);

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  const hasCreds = Boolean(clientId && clientSecret && refreshToken);
  console.log(`Refresh token configured: ${refreshToken ? "yes" : "no"}`);
  console.log(`Client ID configured: ${clientId ? "yes" : "no"}`);

  if (!hasCreds) {
    console.log("Access token refresh: SKIPPED (missing credentials)");
    process.exitCode = 1;
    return;
  }

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const result = await oauth2Client.getAccessToken();
    const token = result?.token;

    if (!token) {
      throw new Error("getAccessToken() returned no token");
    }

    console.log("Access token refresh: OK");
  } catch (err) {
    console.log("Access token refresh: FAILED");
    if (err?.code) console.log(`Error code: ${err.code}`);
    if (err?.response?.status) {
      console.log(`HTTP status: ${err.response.status}`);
    } else if (err?.statusCode) {
      console.log(`HTTP status: ${err.statusCode}`);
    }
    if (err?.message) console.log(`Message: ${err.message}`);
    if (err?.cause) {
      const cause = err.cause;
      console.log(`Cause: ${cause.code ?? cause.message ?? String(cause)}`);
    }
    process.exitCode = 1;
  }
}

main();
