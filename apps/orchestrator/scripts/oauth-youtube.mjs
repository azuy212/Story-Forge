#!/usr/bin/env node

// One-time YouTube OAuth setup for the publisher service.
//
//   1. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in
//      apps/orchestrator/.env
//   2. Run `node scripts/oauth-youtube.mjs` from apps/orchestrator.
//   3. Authorize in the browser.
//   4. The refresh token is printed to the terminal.
//   5. Add it to .env as YOUTUBE_REFRESH_TOKEN=...
//
// The pipeline itself never runs this flow; it reuses the refresh token and
// googleapis auto-refreshes access tokens.
//
// Network runtime (IPv4-only sockets) is configured before googleapis is
// used so the standard OAuth2Client.getToken() path works on hosts without
// IPv6. Do not reintroduce a custom https token-exchange workaround.

import "../src/runtime/network.mjs";

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import googleapis from "googleapis";
import dotenv from "dotenv";

const { google } = googleapis;

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
dotenv.config({ path: envPath });

const PORT = Number(process.env.YOUTUBE_OAUTH_PORT ?? 8080);
const REDIRECT_URI = `http://localhost:${PORT}/auth`;

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in apps/orchestrator/.env",
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const scopes = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/spreadsheets",
];

const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: scopes,
});

console.log(`\nAuthorize this app:\n\n${url}\n`);

const server = createServer(async (req, res) => {
  const parsed = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (parsed.pathname !== "/auth") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const error = parsed.searchParams.get("error");

  if (error) {
    const description = parsed.searchParams.get("error_description") ?? error;

    res.writeHead(400, {
      "content-type": "text/html; charset=utf-8",
    });

    res.end(`<h1>Authorization failed</h1><p>${escapeHtml(description)}</p>`);

    console.error(`\nGoogle authorization failed: ${description}\n`);

    server.close();
    return;
  }

  const code = parsed.searchParams.get("code");

  if (!code) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
    });

    res.end("Missing authorization code");
    return;
  }

  // Respond to the browser immediately.
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
  });

  res.end(
    "<h1>Authorization received</h1>" +
      "<p>You can close this browser window. " +
      "The refresh token will be printed in the terminal.</p>",
  );

  // Give the HTTP response a moment to reach the browser before closing.
  await new Promise((resolve) => setTimeout(resolve, 300));

  try {
    console.log("\nExchanging authorization code for tokens...");

    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh_token returned. Ensure prompt=consent and access_type=offline.",
      );
    }

    console.log("\nRefresh token:\n");
    console.log(tokens.refresh_token);
    console.log("\nAdd to apps/orchestrator/.env as:\n");
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    console.log("OAuth setup completed successfully.");
  } catch (err) {
    console.error("\nToken exchange failed:");

    if (err?.response) {
      console.error(JSON.stringify(err.response, null, 2));
    } else if (err?.message) {
      console.error(err.message);
      if (err.code) console.error(`Error code: ${err.code}`);
      if (err.statusCode) console.error(`HTTP status: ${err.statusCode}`);
      if (err.cause) console.error(`Cause: ${err.cause}`);
    } else {
      console.error(err);
    }

    process.exitCode = 1;
  } finally {
    server.close();
  }
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. ` +
        `Set YOUTUBE_OAUTH_PORT to another port and register the matching redirect URI.`,
    );
  } else {
    console.error("OAuth server error:", err);
  }

  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Waiting for the browser redirect to ${REDIRECT_URI} ...`);
});
