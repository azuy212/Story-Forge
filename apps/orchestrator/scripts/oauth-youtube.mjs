#!/usr/bin/env node
// One-time YouTube OAuth setup for the publisher service.
//
//   1. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in apps/orchestrator/.env
//      (Google Cloud Console -> OAuth client for a desktop/web app).
//   2. Run `node scripts/oauth-youtube.mjs` from apps/orchestrator.
//   3. Authorize in the browser; the refresh token is printed to the terminal.
//   4. Add it to .env as YOUTUBE_REFRESH_TOKEN=...
//
// The pipeline itself never runs this flow; it reuses the refresh token and
// googleapis auto-refreshes access tokens.
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
  "https://www.googleapis.com/auth/drive",
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
  const code = parsed.searchParams.get("code");
  if (!code) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Missing authorization code");
    return;
  }

  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    "<h1>Done</h1><p>Copy the refresh token printed in the terminal.</p>",
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh_token returned. Ensure prompt=consent and access_type=offline.",
      );
    }
    console.log(`\nRefresh token:\n\n${tokens.refresh_token}\n`);
    console.log("Add to apps/orchestrator/.env as:");
    console.log("YOUTUBE_REFRESH_TOKEN=<token>");
  } catch (err) {
    console.error("Token exchange failed:", err.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for the browser redirect to ${REDIRECT_URI} ...`);
});
