# admin-ui

Local control panel for the YouTube Shorts pipeline and providers. Replaces the
day-to-day CLI invocations (`run-next`, `seed-run`, `resume`) with a small web UI,
and adds read/write surfaces for the image-provider, TTS, and transcriber services.

## What it gives you

- **Runs list** — every run under `apps/orchestrator/runs/*` with computed status
  (`new` / `running` / `incomplete` / `failed` / `published` / `aborted`),
  filterable by status / profile / source / free text.
- **Run detail** — header (topic, pillar, profile, source, projectId, publish
  slot, thread history), 18-stage pipeline grid, live producer-node progress bar,
  live log stream (SSE-tail), and every action the CLI scripts expose:
  - `Resume` (uses persisted `run.json`)
  - `Resume…` (override pillar / topic / profile / `--seed` / dry-run)
  - `Dry-run resume`
  - `Cancel` (SIGTERM the running child)
  - `Abort` (cancel + write `abortedAt` to `run.json`)
  - `Edit` (patch pillar / topic / videoProfile / projectId / youtubePublishAt)
  - `Delete` (removes `runs/<ns>/`)
- **Launch** — tabbed forms for `run-next.mjs` (backlog) and `seed-run.mjs` (every
  flag the scripts accept: `seedPath`, `pillar`, `topic`, `profile`, `publishAt`,
  `projectId`, `convert` mode, `dryRun`).
- **YouTube Auth** — one-click OAuth flow. Spawns `oauth-youtube.mjs`, captures
  the auth URL, lets you paste the refresh token, saves it to
  `apps/orchestrator/.env` with a `.bak` backup.
- **Image Provider** — prompt + type + generate via proxy, renders base64
  results, shows cache hits.
- **TTS** — voice picker (lists `apps/tts/app/voices/`), text area, history of
  the last 20 generations with audio player and download.
- **Transcriber** — audio upload + optional known transcript, word table with
  start / end / score.
- **Home** — 4-card service health grid, recent runs, quick actions.

## Run

```bash
pnpm install           # adds admin-ui to the workspace
pnpm dev:admin         # vite (5173) + fastify (2025) in parallel
# open http://127.0.0.1:5173
```

Both processes are managed by `concurrently`; SIGINT stops both.

The other services (orchestrator langgraph dev server, image-provider, tts,
transcriber) are not started by `dev:admin` — run `pnpm dev` from the repo root
to start everything in parallel, or just the ones you need.

## Architecture (one paragraph)

`apps/admin-ui/server/` is a Fastify app on port 2025. It imports the
orchestrator's `run-meta.mjs` helper for atomic run.json writes; the rest of
the orchestrator integration is via child-process spawn of the existing
`run-next.mjs` / `seed-run.mjs` / `resume.mjs` scripts. The `runs/*` directory
is read directly. The image-provider, TTS, and transcriber are reached via
`@fastify/http-proxy` to their existing Fastify / FastAPI servers. SSE is
implemented natively (no `ws`).

`apps/admin-ui/ui/` is a Vite + React 18 + TypeScript app. It uses Tailwind
via CDN (no build step) and a 20-line hash router (no react-router). All
state is `useState` per page. Run log streaming goes through a small `useSse`
hook that auto-reconnects on disconnect.

## Configuration

Environment variables (all optional, defaults match the rest of the monorepo):

| Var | Default | Purpose |
|---|---|---|
| `ADMIN_UI_PORT` | `2025` | admin-ui backend port |
| `LANGGRAPH_URL` | `http://localhost:2024` | upstream orchestrator |
| `IMAGE_PROVIDER_URL` | `http://localhost:8020` | upstream image-provider |
| `TTS_URL` | `http://localhost:8010` | upstream TTS |
| `TRANSCRIBER_URL` | `http://localhost:8030` | upstream transcriber |
| `ARTIFACT_STORE_DIR` | `apps/orchestrator/runs` | run directory root |

Secrets stay in `apps/orchestrator/.env` (the only file the OAuth save flow
writes). Never commit `.env`.

## Skipped (add when needed)

- No auth / multi-user
- No persistent DB — `runs/` filesystem is the source of truth
- No real-time multi-tab sync
- No tests for the UI itself (orchestrator's 708 unit + integration tests gate
  the underlying scripts; UI errors are caught by manual smoke)
- No backlog sheet viewer (kept out per scope decision)
