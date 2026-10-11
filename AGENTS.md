# Repository Instructions

## Layout

- `apps/orchestrator` — LangGraph TypeScript entrypoint (`langgraph.json` → `src/graph/index.ts:graph`). Coordinates all services over HTTP.
- `apps/image-provider` — pnpm workspace package (Playwright + Fastify). Serves image generation via Gemini. Internal layout: `src/core/` (`gemini-client.ts`, `media-collector.ts`, `gemini-error-detector.ts`, `reference-upload.ts`, `retry.ts`, `errors.ts`, `types.ts`), `src/http/` (`app.ts`, `server.ts`, `routes/`, `error-envelope.ts`, `request-schema.ts`, `payloads.ts`), `src/cli/`, `src/storage/`, and `src/config.ts` / `src/logger.ts` / `src/index.ts` at the root. `createApp()` builds the Fastify app without lifecycle so routes are testable in-process via `app.inject()`.
- `apps/tts` — Standalone Python 3.11 FastAPI service (ChatterBox TTS). Not a workspace package. Port 8010.
- `apps/transcriber` — Standalone Python 3.11 FastAPI service (WhisperX forced alignment). Not a workspace package. Port 8030.
- Orchestrator prompts are runtime files under `apps/orchestrator/prompts/`. Prompt loading resolves from CWD — run orchestrator commands via pnpm filters or from its package directory.

## Setup And Services

- Use pnpm `10.34.3` and Node.js 20+; CI tests Node 20 and 22 (unit + convention + graph-docs + Python 3.11 jobs).
- `pnpm run setup:all` — installs JS deps, installs Chromium (Playwright), creates both Python venvs, installs requirements/dev tools, copies missing app `.env` files.
- Secrets only in ignored app `.env` files. Real orchestrator LLM calls require `OPENROUTER_API_KEY`. Provider URLs default: `TTS_URL=8010`, `IMAGE_PROVIDER_URL=8020`, `TRANSCRIBER_URL=8030`.
- `pnpm dev` starts all four services concurrently. Python commands must run from each service directory; root scripts handle this. Native processes are intentional (TTS/transcriber use PyTorch MPS on Apple Silicon).
- `USE_REAL_PROVIDERS=false` (default) selects orchestrator stubs for local tests/dev; real mode requires provider services running. Image provider stores Google auth in ignored `apps/image-provider/browser-profile/`.

## Verification

- Root: `pnpm test`, `pnpm lint`, `pnpm build`.
- `pnpm lint` = orchestrator Oxlint + LangGraph path validation + image-provider Oxlint + Ruff (both Python services) + conventions + graph-docs checks.
- `pnpm test:python` (TTS + transcriber pytest), `pnpm test:int` (orchestrator integration), `pnpm contract:smoke` (provider HTTP contract against running services).
- Orchestrator focused:
  - `pnpm --filter youtube-shorts-orchestrator typecheck`
  - `pnpm --filter youtube-shorts-orchestrator format:check`
  - `pnpm --filter youtube-shorts-orchestrator exec node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathPatterns=tests/<file>.test.ts`
- Orchestrator unit tests use DI via `RunnableConfig.configurable`/agent injection — **do not add `jest.mock()`**.
- Integration tests: `pnpm --filter youtube-shorts-orchestrator test:int` (mock LLM responses).
- Transcriber smoke test: from `apps/transcriber`, run `bash tests/test_align.sh` (needs macOS `say`, `ffmpeg`, `ffprobe`, service venv/models).
- Format via package scripts (`format`), not ad hoc formatter settings.
- TypeScript is strict ESM: retain `.js` import specifiers; avoid direct `process.env` in agents — use `src/utils/config.ts`.

## Pipeline Overview (Orchestrator)

23 nodes (`addNode` calls in `src/graph/index.ts`) wired with conditional edges. The
declaration order below is the spine; retry loops and the entry router's seeded-state
shortcuts are listed underneath.

```
ResolveProfile → ResearchAgent → ResearchQA → ScriptPlanner → ScriptWriter
→ ScriptQA → MetadataGenerator → ThumbnailGenerator → VisualDirector
→ BranchJoin → AssetStrategy → ImagePromptGenerator → PromptQA
→ AssetGenerator → ImagePromptRepair → NarrationGenerator
→ SubtitleGenerator → VideoComposer → ReleaseValidation
→ ReleaseReview → PublishReady → Publisher → Finalize
```

- `scripts/check-graph-docs.sh` derives the node list from `src/graph/index.ts` and asserts
  this section contains exactly those names in order — rename a node without updating this
  block and `pnpm lint` fails.
- Entry router: `ResolveProfile` can jump straight to `VisualDirector` (research + script
  already seeded) or `ScriptPlanner` (research only); otherwise the spine starts at
  `ResearchAgent`.
- QA gates (ResearchQA, ScriptQA, PromptQA, ReleaseValidation, ReleaseReview) can trigger retry loops back to producers.
- `VisualDirector` fans out to `MetadataGenerator` and `ThumbnailGenerator`, which run in parallel and synchronize at `BranchJoin`; only then does the production spine (`AssetStrategy`) start. If a branch dies its guard routes to `Finalize`, so `BranchJoin` can never release with a half pair.
- `AssetGenerator` routes failing scene prompts through `ImagePromptRepair` and back; only when every scene has an asset does the run reach `NarrationGenerator`.
- `ReleaseReview` routes to `PublishReady` for the publish-ready handshake and `Publisher` for the upload itself; `Finalize` is the single exit every failure path terminates at.
- All LLM agents use `runAgent()` harness: loads prompt from `prompts/`, splits on `\n---\n`, renders `{{variable}}`, injects editorial guidelines, invokes OpenRouter with `json_object`, retries on invalid JSON/schema failure, validates with Zod.
- Scene-bounded narration: `NarrationGenerator` creates one TTS artifact per scene, concatenates via FFmpeg. `SubtitleGenerator` creates cues from same narration + measured scene durations (deterministic proportional timing, not waveform alignment).

## Key Design Decisions (Orchestrator)

- ESM only — `"type": "module"`, imports use `.js` extensions.
- No `jest.mock()` — tests inject mocks via `RunnableConfig.configurable`.
- No `process.env` in agents — accessed through `src/utils/config.ts`.
- No `instanceof` — duck-type guards from `src/utils/errors.ts`.
- Zod v4 — `z.record()` requires 2 args (`z.record(z.string(), z.unknown())`).
- Completeness gate — ImagePromptGenerator rejects LLM output unless every scene maps to exactly one asset.
- Graph guards are fail-closed — require complete outputs before downstream nodes or publishing; preserve this when changing nodes/edges.

## Python Services

### TTS (`apps/tts`)
- FastAPI + Uvicorn, ChatterBox TTS (PyTorch MPS on Apple Silicon).
- `requirements.txt`: fastapi, uvicorn, python-multipart, python-dotenv, torch, torchaudio, chatterbox-tts, soundfile, resemble-perth (git dep).
- Dev: black, ruff, pytest (see `apps/tts/dev-requirements.txt`); pure text-splitting helpers live in `app/text_splitting.py` so they are testable without torch.
- Run: `cd apps/tts && venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8010`

### Transcriber (`apps/transcriber`)
- FastAPI + Uvicorn, WhisperX forced alignment (wav2vec2 on MPS/CPU, Whisper ASR on CPU).
- `requirements.txt`: fastapi, uvicorn[standard], python-multipart, whisperx, torch, torchaudio, numpy.
- Dev: ruff, pytest (see `apps/transcriber/dev-requirements.txt`).
- Config via `.env`: `WHISPERX_MODEL=large-v3`, `WHISPERX_DEVICE=auto`, `WHISPERX_COMPUTE_TYPE=int8`, `WHISPERX_LANGUAGE=en`, `WHISPERX_FORCE_TRANSCRIBE=0`.
- Run: `cd apps/transcriber && venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8030 --env-file .env`
- POST `/align` accepts multipart `audio` (WAV) + optional `text` (known transcript). Returns word-level timestamps.
- Forced alignment only when text + language supplied; otherwise falls back to ASR.

## Provider HTTP Contracts

Every service behind the orchestrator responds to failures with the same
envelope, so a client can always recover a machine-readable code and a
correlation id:

```
{ "error": { "code": "<STABLE_ID>", "message": "<caller-safe>", "requestId": "<12-hex>" } }
```

- `code` is the stable machine id. The image provider additionally reports
  `type` (same value as `code`) plus `provider`, `model`, `retryable`, and
  `rawMessage` for its existing consumers; the orchestrator reads the envelope
  through `src/providers/service-error.ts`, which accepts `type` as the `code`
  alias. Validation errors add a `details` array of `{field, message}`.
- `message` never contains a file path, model internals, or raw exception text.
- `requestId` correlates with the service-side traceback (`logging.exception`
  logs it). TTS: one generation at a time, so a saturated engine answers 429
  `ENGINE_BUSY`; engine failures are 503 `ENGINE_FAILURE`.
- Health is `{ "status": ..., "service": "<id>" }` on `/health`. The TTS service
  also answers `/` with the identical payload (deprecated alias).

`bash scripts/contract-smoke.sh` asserts this contract against running
services (skips any that are unreachable) — it is the fastest way to confirm a
service still honors the envelope after a change.

## Safety

- Never commit `.env`, API keys, Google browser profiles, generated media/audio, model caches, LangGraph artifacts. Local state: `outputs/`, `cache/`, `browser-profile/`, `runs/`, `dist/`.
- Keep service HTTP contracts and provider interfaces explicit.

## Project-Specific Conventions

- Oxlint config at root `.oxlintrc.json` (shared by orchestrator + image-provider). Categories: correctness/error, suspicious/error. `typescript/no-explicit-any: error`.
- Prettier for formatting (run via package scripts).
- Jest with `--experimental-vm-modules` + `ts-jest` for TypeScript ESM tests.
- LangGraph CLI for dev server: `npx @langchain/langgraph-cli dev`.
- Agent telemetry captured per-node (model, tokens, retries, versions).

## Testing Quirks

- 221 unit tests, 8 integration tests passing.
- Unit tests inject mock `createModel`/`provider` via `configurable` — no jest.mock.
- Integration tests run full graph with mock LLM responses.
- ChatterBox TTS cache fingerprint is a deployment contract: bump `CHATTERBOX_CACHE_VERSION` in `chatterbox-tts-provider.ts` when server-side model/voice pipeline changes, or cached scene audio goes stale.
- Transcriber smoke test requires macOS `say`, `ffmpeg`, `ffprobe`.