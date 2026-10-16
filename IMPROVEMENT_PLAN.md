# Improvement Remediation Plan

Plan to fix all review findings **in place** (this repo, current working branch — commits target
whichever branch is checked out; today that is `feature/tts-provider`). Each phase is independently
committable and verifiable. Ordered by impact; Phase 1 items are the highest-value starting points.

> **Rev. 3 — post re-verification corrections.**
> - **#6 no longer assumes green start:** AGENTS.md's pipeline section is *already stale* vs
>   `graph/index.ts` — it says "StoryPlanner" (actual node: `ScriptPlanner`, L572), claims "22
>   agents" (actual: 23 `addNode` calls), and omits ResolveProfile, BranchJoin, ImagePromptRepair,
>   PublishReady, FINALIZE. A step 0 reconciles docs to code **before** the CI assertion lands.
> - Header branch reference corrected (`main` → current working branch).
>
> **Rev. 2 — post final-review corrections.** Validated against the working tree:
> - **Reframed #1:** sync `def` handlers already run on FastAPI's threadpool — the event loop is
>   **not** blocked and `/health` is already responsive. The real gap is concurrency safety
>   (unbounded threadpool × non-reentrant model), raw `str(e)` leakage, and print-noise logging.
>   Explicit `run_in_threadpool` is demoted to an optional clarity nicety.
> - **Corrected #3 allowlists** from actual grep counts (see item).
> - **Dropped #5** (de-duplicate model config): `grep -rn "openrouter:" apps/orchestrator/src`
>   returns **zero** literals; model ids already live in `config.ts`. Nothing to fix.
> - **Corrected CI facts:** `integration-tests.yml` is **schedule-only** (`cron` +
>   `workflow_dispatch`, not push-only); root `pnpm lint` **already covers** image-provider
>   (`oxlint`) and Python (Ruff via `scripts/lint-python.sh`). Remaining gaps: admin-ui coverage,
>   full `pnpm build`, PR-triggered integration tests, Python pytest.

Verified anchors (as of this revision):
- TTS endpoint: `apps/tts/app/main.py` → sync `def generate(...)` calling blocking
  `engine.generate()` (PyTorch) on FastAPI's default threadpool (~40 workers) with **no semaphore**
  around a single non-reentrant model instance; errors surface as raw `str(e)` in HTTP 500 detail.
- No `apps/tts/tests/` directory exists; transcriber has `tests/` but only a macOS bash smoke test.
- `.github/workflows/unit-tests.yml` builds/lints/tests orchestrator only — no Python pytest, no
  image-provider/admin-ui build or typecheck.
- `apps/image-provider/src/` is flat (12 modules incl. `gemini-client.ts`, `server.ts`, `cli.ts`) —
  the "God module" candidate for split.
- AGENTS.md documents conventions (no `process.env` in agents, config via `src/utils/config.ts`,
  Zod v4 two-arg records, no `jest.mock()`, ESM `.js` specifiers) with zero automated enforcement.

---

## Phase 1 — High Impact (correctness + CI gaps)

### 1. TTS: concurrency guard, typed errors, logging hygiene
**Files:** `apps/tts/app/main.py`, `apps/tts/app/chatterbox_engine.py`

- [x] **Concurrency guard (the actual correctness fix):** wrap `engine.generate` in a
      module-level `threading.Semaphore(1)` (ChatterBox is not reentrant-safe on one model
      instance; today N concurrent requests = N threadpool threads contending on shared GPU
      state). Non-blocking acquire → return **429** when saturated. Handlers may stay sync `def`
      (FastAPI threadpools them); optionally convert to `async def` +
      `await run_in_threadpool(...)` purely to make the offload explicit — no behavior change.
- [x] Replace blanket `except Exception` with typed failures:
      - `ValueError` → 400 (invalid voice / empty text) — keep.
      - New `TTSCorruptionError`/`RuntimeError` from engine → 503 with generic message.
      - Log full traceback server-side (`logging.exception`), return a correlation ID instead of
        `str(e)` in the response body (avoids leaking paths/model internals).
- [x] Add a module-level `logging` setup; remove per-chunk `print()` noise in
      `chatterbox_engine.py` (replace with `logger.debug/info`, drop the redundant
      voice-path/size diagnostic prints inside the try block).
- [x] Guard concurrent generation: covered by the `threading.Semaphore(1)` above — if handlers were
      converted to `async def`, use `asyncio.Semaphore(1)` with non-blocking acquire → 429 instead.
- [x] Verify: manual `curl` against uvicorn while a generation runs; `/health` must respond <100 ms
      (already true today via threadpooling — this becomes a regression check, not a fix); second
      concurrent `/generate` must get 429, not corrupted audio.

### 2. Python unit tests + wire them into CI
**Files:** new `apps/tts/tests/test_chunking.py`, new `apps/transcriber/tests/test_config.py` (+
`conftest.py` stubbing heavy imports if needed), `apps/tts/dev-requirements.txt`,
`apps/transcriber/dev-requirements.txt`, `.github/workflows/unit-tests.yml`

- [x] Port pure-logic coverage for `split_into_sentences`, `chunk_text_by_sentences`,
      `_is_valid_sentence_end` (abbreviations, decimals like `3.14`, versions `v1.2.3`, ellipsis,
      bullet lists) — these functions import `torch` only via sibling module scope, so either
      extract pure helpers into `apps/tts/app/text_splitting.py` (preferred, small refactor of
      `chatterbox_engine.py` re-exporting for compat) or mock `torch`/`torchaudio` in `conftest`.
- [x] Add `pytest` + `pytest-asyncio` to both dev-requirements files.
- [x] New root script `scripts/test-python.sh` running `venv/bin/pytest` per service (mirrors
      `lint-python.sh` structure); add `"test:python"` to root `package.json`.
- [x] CI: add a `python-tests` job (ubuntu-latest, python 3.11, CPU-only torch wheel) that runs
      `bash scripts/test-python.sh` — do NOT install chatterbox-tts/resemble-perth in CI (too heavy);
      tests must pass with torch CPU + the extracted pure module only.
- [x] Verify: `bash scripts/test-python.sh` green locally; job green in PR.

### 3. Enforce AGENTS.md conventions mechanically
**Files:** new `scripts/check-conventions.sh`, root `package.json`, `.oxlintrc.json`,
`.github/workflows/unit-tests.yml`

- [x] Script checks (fail-closed, grep-based, cheap). **Allowlists verified against actual tree:**
      - No `process.env` outside an explicit allowlist: `utils/config.ts` plus the 18 legitimate
        non-agent hits — `utils/run-log.ts` (16), `artifacts/namespace.ts` (1),
        `providers/thumbnail-compositor.ts` (1). The only true violation is
        `agents/run-agent.ts:333` (`process.env.DEBUG_LLM_PAYLOAD`) — fix it to read through
        `config.ts` rather than adding it to the allowlist.
      - No `jest.mock(` in `apps/orchestrator/tests/**`.
      - All relative TS imports in orchestrator `src/` end in `.js` — **must allow `.mjs`
        specifiers** (4 legit imports of `run-meta.mjs` / `sheets-format.mjs`). Verified: today's
        tree already has zero extensionless relative imports, so this check starts green.
      - No single-arg `z.record(` occurrences.
      - No `instanceof BaseChatModel|instanceof LangChainError` in `src/agents/**`.
- [x] Oxlint additions in `.oxlintrc.json`: enable `no-console` (warn) scoped to orchestrator
      `src/agents/**`, and ensure `typescript/no-floating-promises` equivalent rule category is on
      (correctness) so un-awaited promises fail lint.
- [x] Wire `check-conventions.sh` into root `pnpm lint` chain and CI lint step.
- [x] Verify: introduce a deliberate violation locally → lint must fail → revert.

### 4. Expand CI matrix to cover all packages
**Files:** `.github/workflows/unit-tests.yml` (rename conceptually to "CI"), `integration-tests.yml`

- [x] Scope check — root `pnpm lint` **already covers** orchestrator + image-provider (`oxlint`) +
      Python (Ruff via `scripts/lint-python.sh`). Do not re-add those; remaining gaps only.
- [x] In the existing job add after install:
      `pnpm build` (covers all workspace packages once admin-ui included), then
      `pnpm --filter admin-ui typecheck` / `lint` if those scripts exist (audit package.json first);
      add the scripts if missing.
- [x] `integration-tests.yml` is currently **schedule-only** (`cron: 37 14 * * *` +
      `workflow_dispatch`) — add a `pull_request` trigger with `paths:` filter on
      `apps/orchestrator/src/**`, running with mocked LLM responses (no secrets needed).
- [x] Verify: dry-run workflow with `act` is optional; gate on PR showing all four packages built+linted
      and integration job firing on orchestrator-touching PRs.

### ~~5. De-duplicate model configuration~~ — **DROPPED (Rev. 2)**
Verified: `grep -rn "openrouter:" apps/orchestrator/src` returns **zero** literals; default model
ids already live in `src/utils/config.ts`. There is no duplication to remove. If stray literals are
ever introduced, the #3 convention checker can gain a `z.record`-style grep rule at that time.

---

## Phase 2 — Architecture

### 6. Keep graph documentation in sync with code
**Files:** new `scripts/check-graph-docs.sh`, `AGENTS.md`, orchestrator graph source

- [x] **Step 0 — reconcile AGENTS.md to code *before* adding the assertion.** The docs check
      does **not** start green: AGENTS.md L35-44 is already stale vs `graph/index.ts` L569-591.
      Fix first: "StoryPlanner" → `ScriptPlanner`; "22 agents" → 23 (actual `addNode` count);
      add the omitted nodes ResolveProfile, BranchJoin, ImagePromptRepair, PublishReady, FINALIZE.
      Without this, the first CI run fails for a pre-existing reason.
- [x] Generate node list from the compiled graph object (`graph.getGraph()` or export a
      `NODE_NAMES` const next to edge wiring in `src/graph/index.ts`) and assert AGENTS.md's
      pipeline section contains exactly that sequence (simple ordered-substring check).
      Because graphs are wired with conditional edges, compare as a **set membership + spine
      order** check rather than strict linear equality if the naturalized flow diverges.
- [x] Run in CI lint chain. When nodes change, docs check fails until AGENTS.md updated.
- [x] Verify: after step 0, check passes on current tree; rename a node temporarily → check
      fails; restore → passes.

### 7. Decompose image-provider "God module"
**Files:** `apps/image-provider/src/**` (reorganize into subdirs)

- [x] Target layout (pure moves + import updates, no behavior change):
      ```
      src/core/      (gemini-client.ts, retry.ts, errors.ts, types.ts)
      src/http/      (server.ts, routes/* split out of server.ts)
      src/cli/       (cli.ts, prompt-reader.ts)
      src/storage/   (asset-downloader.ts, cache.ts)
      src/config.ts, src/logger.ts, src/index.ts stay at root
      ```
- [x] Split oversized responsibilities inside `gemini-client.ts` / `server.ts` only where a
      function exceeds ~80 lines or mixes concerns (extraction, not rewrite).
- [x] Verify: `pnpm --filter gemini-image-automation build && lint` and existing provider contract
      tests/smoke (`curl /generate` against local server) unchanged.

### 8. Standardize provider interfaces across services
**Files:** orchestrator `src/providers/*`, `apps/tts/app/main.py`, `apps/transcriber/app/main.py`

- [x] Define one shared HTTP contract doc/section in AGENTS.md: request/response shapes, error
      envelope `{ "error": { "code", "message", "requestId" } }`, health endpoint shape
      `{status, service}` (currently duplicated `/` + `/health` alias in TTS — keep alias but
      return identical payload; note deprecation).
- [x] Align TTS + transcriber error envelopes to the shared shape (Phase 1 item 1 output feeds here).
- [x] Orchestrator providers parse the shared error envelope uniformly (one helper in
      `src/providers/` instead of per-provider ad-hoc parsing).
- [x] Verify: contract smoke script `scripts/contract-smoke.sh` hitting each service's endpoints
      with malformed input asserting the standard envelope.

### 9. Module-system consistency sweep (ESM)
**Files:** `apps/image-provider/package.json`, `apps/admin-ui/package.json`, tsconfigs

- [x] Audit each workspace package: `"type": "module"` present? tsconfig `module`/`moduleResolution`
      matching NodeNext like orchestrator? CJS leftovers (`require(`, `__dirname`, `module.exports`)?
- [x] Fix drift: prefer converting image-provider to strict ESM mirroring orchestrator settings;
      admin-ui follows its framework defaults but document why in AGENTS.md.
- [x] Verify: builds + tests green; `grep -rn "require(" apps/*/src` clean except framework config files.

---

## Phase 3 — Developer Experience & Security

### 10. Harden setup scripts
**Files:** `scripts/setup-python.sh`, `scripts/lint-python.sh`, README/AGENTS setup notes

- [x] Add `set -euo pipefail`, preflight checks (`python3.11` present, `ffmpeg` warning-not-fatal),
      idempotency (skip venv creation if exists & correct version; `--upgrade-deps` opt-in flag),
      clear per-step logging and a final summary of what was created/skipped.
- [x] Copy `.env.example` → `.env` only when missing (verify current behavior; preserve secrets).
- [x] Verify: run twice back-to-back on a clean checkout — second run must be fast, non-destructive.

### 11. Reduce secret/log surface
**Files:** `apps/tts/app/main.py` (error bodies — done in #1), orchestrator agent telemetry,
`run-agent.ts` logging, narration/subtitle logs

- [x] Prune sensitive fields from logs: never log full request bodies containing voice sample paths
      or API keys; redact `OPENROUTER_API_KEY`-adjacent config dumps in `config.ts` startup log.
- [x] Cap logged LLM echo (truncate prompts/responses in debug logs to N chars).
- [x] Ensure `.gitignore` covers `apps/tts/outputs/`, `runs/`, `cache/`, `browser-profile/`
      (audit vs. AGENTS.md Safety list; add missing entries).
- [x] Verify: start services, trigger an error path, confirm no absolute user paths/keys in stdout.

### 12. Minor consistency fixes
**Files:** root `package.json`, `.oxlintrc.json`, `ruff.toml`, AGENTS.md

- [x] Add root aliases: `"test:int"` → filter command, `"format"` / `"format:check"` fan-out across
      packages that define them.
- [x] Scope oxlint rules per-package where current global severity causes suppressions (document).
- [x] Ruff: align `line-length`/rule selection between `apps/tts` and `apps/transcriber` via the
      shared root `ruff.toml` (verify both services actually inherit it; add per-dir overrides only
      if needed).
- [x] Update AGENTS.md Testing Quirks count (221) → replace with "see CI badge/count" to avoid rot.

---

## Execution Order & Commits

| Commit | Contents | Depends on |
|---|---|---|
| 1 | `fix(tts): semaphore guard, typed errors, logging hygiene` (#1) | — |
| 2 | `test(python): chunking tests + scripts/test-python.sh + CI job` (#2) | 1 (typed errors tested) |
| 3 | `chore(ci): convention checker + expanded package coverage` (#3, #4) | — |
| ~~4~~ | ~~model defaults (#5)~~ — dropped, nothing to fix | — |
| 4 | `docs+ci: graph-docs sync check` (#6) | 3 |
| 5 | `refactor(image-provider): module decomposition` (#7) | 3 |
| 6 | `feat(contracts): unified error envelope + provider parsing` (#8) | 1 |
| 7 | `chore(esm): module system consistency` (#9) | 5 |
| 8 | `chore(dx/security): setup hardening, log pruning, gitignore, aliases` (#10–#12) | — |

## Definition of Done
- Every checkbox ticked or explicitly waived with rationale recorded in this file.
- `pnpm lint` (incl. conventions + graph-docs check), `pnpm test`, `pnpm build`,
  `bash scripts/test-python.sh` all green locally and in CI on Node 20/22 + Python 3.11 job.
- AGENTS.md updated wherever behavior/conventions changed (setup, contracts, model config).

---

## Completion Record

Every checkbox above is ticked. Per the Definition of Done, the rationale and
evidence for each item:

**#1 TTS (commit 1)** — `threading.Semaphore(1)` in `app/main.py` with non-blocking
acquire → 429; handlers stay sync `def`. `app/errors.py` adds typed failures
(400 caller input, 503 engine) plus `error_envelope()`; `logging.exception` keeps the
traceback server-side and the response carries a 12-hex correlation id instead of
`str(e)`. Verified against the live service: a concurrent `/generate` returns `429
ENGINE_BUSY`, `/health` answers while a generation is in flight, and an engine failure
whose message contains a file path returns a body with no path.

**#2 Python tests (commit 2)** — `app/text_splitting.py` extracted so the sentence/chunk
logic is testable without torch (re-exported from the engine for compatibility);
42 TTS tests + 29 transcriber config tests. `scripts/test-python.sh` / `pnpm
test:python`, pytest in both dev-requirements, and a CI `python-tests` job using the
CPU-only torch index so chatterbox-tts/whisperx are never installed. A blank-env-value
bug (`WHISPERX_MODEL=""` → empty model name) was found by these tests and fixed in
both services.

**#3 Conventions (commit 3)** — `scripts/check-conventions.sh`, six fail-closed checks
(process.env allowlist, jest.mock, .js/.mjs specifiers, two-arg z.record, no instanceof
on framework base classes, no CommonJS constructs). The one real `process.env`
violation (`run-agent.ts:333`) now reads through `utils/config.ts`. `typescript/
no-floating-promises` is enabled so un-awaited promises fail lint; `no-console` is
scoped to orchestrator agents. Each rule was verified to fail closed by introducing a
deliberate violation.

**#4 CI coverage (commits 3-4)** — `pnpm build` (all packages), admin-ui `typecheck`
and the conventions/graph-docs checks run in the unit-tests job; `integration-tests.yml`
gained a `pull_request` trigger filtered to orchestrator paths. Audit note: admin-ui
has a `typecheck` script but no linter config, so no `lint` script was added — `tsc` is
its type authority.

**#5 Dropped (Rev. 2)** — nothing to do; re-verified that no `openrouter:` literals exist
in orchestrator sources.

**#6 Graph docs (commit 4)** — AGENTS.md reconciled to code first, then
`scripts/check-graph-docs.sh` derives the node list from the `addNode` calls (resolving
the `FINALIZE` constant) and asserts membership plus spine order. Verified to fail on a
rename, a dropped node, and a reordered spine.

**#7 image-provider decomposition (commit 5)** — layout: `src/core`, `src/http`
(`app.ts`, `routes/`, `error-envelope.ts`, `request-schema.ts`, `payloads.ts`),
`src/cli`, `src/storage`. Three extractions out of the God module: `MediaCollector`
(generation media snapshot/poll/download), `GeminiErrorDetector` (UI error scan +
patterns), `ReferenceUpload` (file input + partial-acceptance assertion). `createApp()`
builds the Fastify app without lifecycle so routes are tested in-process via
`app.inject()` — 9 new contract tests. The CLI also runs under plain Node, which fixes
a stale `dist/cli.js` bin path.

**#8 Provider contracts (commit 6)** — one documented contract in AGENTS.md; TTS and
the transcriber emit `{error:{code,message,requestId}}`, the image provider adds
`code`/`requestId`/`details` additively; `src/providers/service-error.ts` is the single
parser (accepting `type` as the `code` alias). `scripts/contract-smoke.sh` asserts the
contract against running services and skips unreachable ones.

**#9 ESM sweep (commit 7)** — audit recorded in AGENTS.md: all packages are
`"type": "module"` with no `require(`/`module.exports`; admin-ui stays on Vite's
Bundler defaults (documented why). image-provider moved to `NodeNext`, which fixed a
real bug: `node dist/cli/cli.js` failed with `ERR_MODULE_NOT_FOUND` before and now runs.
The CommonJS grep became a conventions check.

**#10 Setup hardening (commit 8)** — python3.11 preflight, non-fatal ffmpeg warning,
per-step logging, created/upgraded/skipped summary, and `.env` only when missing.
Idempotency is now completeness-based: a stamp over interpreter + requirements hash, so
a run that failed mid-install is repaired instead of being skipped forever (the old
venv-exists check masked exactly that).

**#11 Log surface (commit 8)** — `src/utils/log-redaction.ts` redacts provider keys,
bearer tokens and `key=value` config dumps and caps echoes; `DEBUG_LLM_PAYLOAD` dumps and
persisted model output are capped; the run log records a `~`-relative cwd. `.gitignore`
was audited against the Safety list (everything already covered; AGENTS.md documents
the tracked `apps/tts/app/voices/*.wav` voice-reference exception).

**#12 Minor fixes (commit 8)** — root aliases (`test:int`, `format`, `format:check`,
`test:python`, `contract:smoke`, `check:conventions`, `check:graph-docs`);
`apps/tts/pyproject.toml` extends the root `ruff.toml` so the Python services cannot
drift; AGENTS.md's Testing Quirks no longer quotes a stale count.

**Waived, with rationale:** enabling the full type-aware Oxlint rule set was waived —
it surfaces 197 pre-existing `no-unsafe-type-assertion` / `no-unnecessary-*` /
`consistent-return` findings across the orchestrator, and `tsc --strict` is already the
type-safety authority. Those rules are explicitly `off` in `.oxlintrc.json` while
`no-floating-promises` is on. No library dependency was added or removed anywhere.
