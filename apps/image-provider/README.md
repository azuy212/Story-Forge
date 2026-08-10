# Gemini Image Automation

Automate Google Gemini image and video generation through the web interface using Playwright and TypeScript.

## Prerequisites

- Node.js 18+ (LTS recommended)
- pnpm 8+
- Google Chrome or Chromium installed

## Setup

```bash
pnpm install
cp .env.example .env
```

Edit `.env` to configure behaviour. Defaults work out of the box.

## Usage

### CLI

```bash
pnpm cli --help
```

**Generate assets interactively** (prompts you on the CLI):

```bash
pnpm cli generate
```

**Generate from a single prompt:**

```bash
pnpm cli generate "a cute cat wearing a wizard hat, digital art"
```

**Generate a video:**

```bash
pnpm cli generate "a timelapse of clouds over mountains" --type video
```

**Generate from a prompts file** (one prompt per line, `#` for comments):

```bash
pnpm cli generate --prompts-file prompts.txt
```

**Sign in once and save the session** (opens a browser; only needed the first time):

```bash
pnpm cli login
```

**Start the HTTP API server:**

```bash
pnpm cli server --port 3000
```

### HTTP API

`POST /generate` with a JSON body:

```json
{ "prompt": "a cute cat wearing a wizard hat", "type": "image" }
```

- `type`: `image` (default) or `video`.
- Send `Accept: application/json` for a structured response, otherwise the first
  generated asset is returned with the correct content type.

JSON response:

```json
{
  "prompt": "a cute cat wearing a wizard hat",
  "type": "image",
  "count": 1,
  "fromCache": false,
  "media": [{ "filename": "image-1", "mime": "image/png", "base64": "..." }]
}
```

The browser starts lazily — if the prompt is already in the cache it is served
directly with no browser launch or sign-in required.

### Legacy batch runner

The original file-based runner is still available:

```bash
pnpm dev
```

1. Add prompts to `prompts.txt` (one per line).
2. Run in headed mode (default) — a browser opens.
3. Sign in to Google when the browser opens. The session is saved to `browser-profile/` — you only need to sign in once.
4. The script processes each prompt and saves results to `outputs/YYYY-MM-DD/prompt-slug/`.

### CLI options

Common flags (also passed to env config):

| Flag | Description |
|---|---|
| `--headless` | Run browser in headless mode |
| `-o, --output <dir>` | Asset output directory |
| `-l, --log-level <level>` | `debug`, `info`, `warn`, `error` |
| `-p, --profile <dir>` | Browser user data directory |

`generate` flags:

| Flag | Description |
|---|---|
| `-f, --prompts-file <file>` | Batch prompts from a file |
| `-c, --concurrency <n>` | Number of prompts to process in parallel |
| `-t, --type <type>` | Asset type: `image` (default) or `video` |

## Output structure

```
outputs/
  2026-07-28/
    a-cute-cat-wearing-a-wizard-hat/
      image-1.png
      image-2.png
      metadata.json
    a-timelapse-of-clouds-over-mountains/
      video-1.mp4
      metadata.json
  ...
```

`metadata.json`:

```json
{
  "prompt": "a cute cat wearing a wizard hat, digital art",
  "timestamp": "2026-07-28T12:00:00.000Z",
  "assetType": "image",
  "assetCount": 2,
  "assetFilenames": ["image-1.png", "image-2.png"]
}
```

## Caching

Generated assets are cached under `CACHE_DIR` (default `./cache`), keyed by a
hash of the exact prompt and asset type. If a request matches a cached entry
(validated by exact prompt **and** asset type), the stored assets are returned
instead of regenerating — in both CLI and server mode. The server never starts
the browser for a cache hit.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GEMINI_URL` | `https://gemini.google.com` | Gemini web URL |
| `BROWSER_HEADLESS` | `false` | Run browser in headless mode |
| `BROWSER_EXECUTABLE_PATH` | — | Path to custom Chrome/Chromium binary |
| `USER_DATA_DIR` | `./browser-profile` | Persistent profile directory |
| `CONCURRENCY` | `1` | Number of prompts to process in parallel |
| `TIMEOUT` | `180000` | Per-operation timeout (ms) |
| `VIDEO_TIMEOUT` | `300000` | Video generation wait timeout (ms) |
| `AUTHENTICATION_TIMEOUT` | `300000` | Max wait for manual sign-in (ms) |
| `RETRY_MAX_ATTEMPTS` | `3` | Retries on transient failures |
| `RETRY_BASE_DELAY_MS` | `2000` | Initial retry backoff (ms) |
| `DOWNLOAD_DIR` | `./outputs` | Asset output directory |
| `CACHE_DIR` | `./cache` | Persistent asset cache directory |
| `PROMPTS_FILE` | `./prompts.txt` | Input prompt file |
| `GENERATION_TYPE` | `image` | Asset type: `image` or `video` |
| `LOG_LEVEL` | `info` | Log verbosity: debug, info, warn, error |

## npm scripts

| Script | Action |
|---|---|
| `pnpm dev` | Run the legacy batch runner with tsx |
| `pnpm cli` | Run the CLI with tsx (`pnpm cli <command>`) |
| `pnpm build` | Compile TypeScript to dist/ |
| `pnpm start` | Run the CLI via tsx |
| `pnpm serve` | Run the HTTP API server directly |
| `pnpm lint` | Run strict Oxlint checks |
| `pnpm format` | Format with Prettier |

Installed as a package, the CLI binary is exposed as `gemini-image`.

## Architecture

```
src/
  config.ts           Environment & defaults
  logger.ts           Structured JSON logger
  retry.ts            Async retry with exponential backoff
  prompt-reader.ts    Read prompts from file
  asset-downloader.ts Save images/videos + metadata.json
  cache.ts            Persistent asset cache (exact prompt + type match)
  types.ts            Shared types (asset type, assets, generation result)
  gemini-client.ts    Playwright automation logic
  cli.ts              Commander-based CLI entry point
  server.ts           HTTP API server
  index.ts            Legacy batch runner
```

Key design decisions:

- **Persistent browser profile** — sign into Gemini once; session survives restarts.
- **Create-mode selection** — image/video requests toggle the matching option
  (`Create image` / `Create video`) in Gemini's "+" menu before submitting.
- **No arbitrary sleep() calls** — all waits use locators, DOM mutation observers, or network events.
- **Network response interception** — captures image and video binaries as they load, avoiding re-downloads.
- **Blob URL support** — if Gemini serves assets as blob: URLs, fetches them via page context.
- **Exact-match caching** — cache keys hash the exact prompt + asset type; validation rejects mismatched metadata.
- **Lazy browser startup** — the server only launches the browser when a request misses the cache.
- **Error detection** — scans for content policy, rate limit, and generation failure messages.
- **Graceful shutdown** — SIGINT/SIGTERM closes browser cleanly.
- **Retry with backoff** — exponential backoff + jitter for transient failures.

## Platforms

Tested on macOS. Works on Linux and Windows with appropriate Chrome/Chromium.

## Notes

- Gemini's UI may change — locators are designed with fallbacks.
- If the output directory fills up, generated assets persist in the browser profile (from Gemini's own history).
- Video generation can take several minutes; adjust `VIDEO_TIMEOUT` if needed.
