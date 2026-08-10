# Repository Instructions

## Layout

- `apps/orchestrator` is the LangGraph TypeScript entrypoint (`langgraph.json` -> `src/graph/index.ts:graph`) and coordinates all other services over HTTP.
- `apps/image-provider` is the other pnpm workspace package. `apps/tts` and `apps/transcriber` are standalone Python 3.11 services with separate `venv` directories; they are not workspace packages.
- Orchestrator prompts are runtime files under `apps/orchestrator/prompts/`. Prompt loading resolves from the current working directory, so run orchestrator commands through pnpm filters or from its package directory.

## Setup And Services

- Use pnpm `10.34.3` and Node.js 20+; CI tests Node 20 and 22. Run `pnpm run setup:all` to install JS dependencies, install Chromium, create both Python venvs, install requirements/dev tools, and copy missing app `.env` files.
- Configure secrets only in ignored app `.env` files. Real orchestrator LLM calls require `OPENROUTER_API_KEY`; `TTS_URL`, `IMAGE_PROVIDER_URL`, and `TRANSCRIBER_URL` default to ports `8010`, `8020`, and `8030`.
- `pnpm dev` starts all four services. Python commands depend on being run from each service directory; root scripts already do this. Native processes are intentional because TTS/transcriber use PyTorch MPS on Apple Silicon.
- `USE_REAL_PROVIDERS=false` selects orchestrator stubs for local tests/development; real mode requires the provider services. The image provider stores Google auth in ignored `apps/image-provider/browser-profile/`.

## Verification

- Root checks: `pnpm test`, `pnpm lint`, `pnpm build`. `pnpm lint` includes orchestrator Oxlint, LangGraph path validation, image-provider Oxlint, and Ruff for both Python services.
- Orchestrator focused checks: `pnpm --filter youtube-shorts-orchestrator typecheck`, `pnpm --filter youtube-shorts-orchestrator format:check`, and `pnpm --filter youtube-shorts-orchestrator exec node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathPatterns=tests/<file>.test.ts`.
- Orchestrator unit tests use dependency injection through `RunnableConfig.configurable`/agent injection; do not add `jest.mock()`. Integration tests are `pnpm --filter youtube-shorts-orchestrator test:int` and use mock LLM responses.
- Transcriber has shell smoke coverage, not pytest: from `apps/transcriber`, run `bash tests/test_align.sh`; it needs macOS `say`, `ffmpeg`, `ffprobe`, and the service venv/models.
- Run formatting with the package scripts (`format`), not ad hoc formatter settings. TypeScript is strict ESM: retain `.js` import specifiers and avoid direct `process.env` access in orchestrator agents; use `src/utils/config.ts`.

## Safety

- Never commit `.env`, API keys, Google browser profiles, generated media/audio, model caches, or LangGraph artifacts. Common local state includes `outputs/`, `cache/`, `browser-profile/`, `runs/`, and `dist/`.
- Keep service HTTP contracts and provider interfaces explicit. Orchestrator graph guards are fail-closed and require complete outputs before downstream nodes or publishing; preserve this behavior when changing nodes or edges.
