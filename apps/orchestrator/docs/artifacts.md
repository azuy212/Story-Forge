# Artifact Persistence & Caching

The pipeline persists every LLM-agent and provider-node output to versioned artifacts
under `runs/<runId>/`. On a cache hit (identical inputs, complete artifact) the LLM
call is skipped and the saved result is reused — making retries and re-runs cheap and
deterministic.

Refactor principle: everything flows through the same nodes and prompts as before;
artifact persistence is layered underneath `runAgent()` and the provider nodes. No
prompt, graph order, or node API changed.

## Enabling

```bash
ARTIFACT_STORE_ENABLED=true npm run start
```

Or per-call via `config.configurable`:

```ts
{ configurable: { artifactStoreEnabled: true, runId: "my-run" } }
```

Tests and embeddings inject a store directly:

```ts
{ configurable: { artifactStore: myStore, runId: "my-run" } }
```

When no store is configured (or `artifactStore: null` / `artifactStoreEnabled: false`
is passed) the pipeline behaves exactly as before — every node computes fresh.

Store directory defaults to `<cwd>/runs`; override with `ARTIFACT_STORE_DIR`.

## Layout

```
runs/<runId>/
  run.json                           # run metadata: threadId, topic, pillar, createdAt, threadHistory[]
  manifest.json                      # per-type index: latest version + version list
  artifacts/<type>/v1.json           # versioned artifact records
  artifacts/<type>/v2.json
  state/execution.json               # { "<type>@v<version>": ArtifactReference, ... }
  assets/                            # (future) binary sidecars
  logs/
```

`run.json` is written atomically on first namespace claim for a thread. It records:

- `threadId` — the LangGraph thread UUID that created the run
- `topic` — the original project topic (e.g., "Why Your Brain Lies to You")
- `pillar` — the project pillar (e.g., "Geography", "History")
- `createdAt` — ISO timestamp of first claim
- `threadHistory` — array of all thread IDs associated with attempts to write to this run folder, including failed resume attempts (appended on each new claim)

This enables resume even when the LangGraph checkpointer has lost the thread, and provides a reverse lookup from run folder to thread ID.

All writes are atomic (`writeFile` to `.tmp` + `rename`). Saves never overwrite — each
write appends a new version.

## Run IDs

A run's identity resolves in priority order:

1. `config.configurable.runId` — explicit override, used verbatim
2. `config.configurable.thread_id` — humanized into a readable namespace
3. `state.execution.runId`

The filesystem namespace is never the raw LangGraph `thread_id` (a UUID). When a run
resolves through `thread_id`, it is rewritten to a human-readable, per-run directory
name derived from the project topic:

```text
unrecognized-countries-20260813-084203-a1b2
```

Format: `<topic-slug>-<YYYYMMDD-HHmmss>-<4-hex>`. The timestamp is the process's
**local time** (deliberate, for human readability); the disk index keeps an existing
thread's namespace stable across processes and timezones, so the stamp only affects
freshly generated names. The suffix disambiguates two runs of the same topic started
within the same second. Resolution is stable per run through two layers:

- **in-process memo** — the first resolution wins, so every node and provider in the
  run writes into the same directory.
- **disk index** (`runs/.run-names/<sanitized-thread-id>`) — the chosen name is
  persisted atomically (`wx` create), so resuming the same `thread_id` in a fresh
  process reuses the same directory and cache continuity holds across restarts.
  Concurrent processes cannot overwrite an established mapping; a loser of the race
  briefly retries reading the winner's entry before generating a name. Filesystem
  failures (permission errors, unwritable `ARTIFACT_STORE_DIR`) are **not** swallowed
  — they surface as errors rather than silently producing a different namespace than a
  concurrent process.

Once a thread has a namespace, later topic changes never move its artifacts: the disk
index is consulted before a new name is generated.

The raw `thread_id` is only sanitized into a filename key; the LangGraph
thread/checkpoint identity is never modified.

A run with no `runId`/`thread_id` (a standalone node invocation) falls back to a
topic-derived name, memoized per raw topic within the process but not persisted to disk —
there is no stable key to index on.

## Lifecycle

Artifacts move through statuses:

- `pending` — written by a node that defers completion (`deferComplete: true`, used by
  `image-prompt-generator`, which validates scene coverage before finishing).
- `complete` — validated and safe to serve from cache.
- `failed` — producer errored.
- `invalid` — rejected by QA or manual review.
- `superseded` — a newer version replaced it.

Only a `complete` artifact whose `inputHash` matches the current call's cache key is
served. `pending` artifacts never satisfy a cache hit.

## Cache Key

An artifact's `meta.inputHash` is `sha256(stableStringify(...))` over:

- agent
- promptPath + `promptHash` (content hash of the prompt file, so editing a prompt
  invalidates automatically)
- variables (template render inputs)
- temperature
- responseFormat
- model (when `configurable.modelForAgent` resolves one)
- agentVersion

Any change recomputes and writes a new version. Semantic validation is an optional
per-node hook (`validateArtifact` in `RunAgentOptions`; e.g. `AssetGenerator` requires
all planned scenes to have assets).

## LLM Usage Records (`llmUsage`)

Every actual LLM call is recorded as an `llmUsage` artifact (`runs/<runId>/artifacts/llmUsage/vN.json`). Unlike node artifacts, `llmUsage` is **write-only accounting**: it is never served from cache and never affects pipeline behavior.

### What is recorded

`runAgent()` and the direct Thumbnail QA call persist a record **immediately after `model.generate()` returns, before JSON/schema validation**. So every token-consuming call is captured, including:

- retries after parse/schema failures (`attempt > 1`),
- requests that later fail validation (the tokens were spent),
- the final successful attempt.

Requests that throw before a response (transport errors, aborts) produce no usage payload and are **not** recorded — there is no usage to report.

Record shape (`src/models/usage.ts`):

```ts
{
  provider: "openrouter",
  model: string,
  requestId: string,           // OpenRouter response id
  promptTokens, completionTokens, totalTokens,
  reasoningTokens, cachedTokens, cacheWriteTokens,  // optional
  costUsd,                     // optional, from OpenRouter usage.cost (fallback total_cost)
  timestamp: ISO string,
  runId, node, attempt, invocationId,
}
```

Missing OpenRouter fields stay `undefined`, never zeroed (so "no reasoning" ≠ "0 reasoning").

### Invocation ID & deduplication

`invocationId` is a random UUID minted **before** the model call, per attempt. The persistence key is `sha256({provider, invocationId})` (see `src/artifacts/hash.ts`), so:

- two attempts at the same node never collide,
- re-running the same attempt (e.g. resume replaying a node whose thread was lost) is deduplicated — the second persist is a no-op,
- OpenRouter `requestId` is kept for traceability but never used as the dedup key (it is absent on some streaming responses).

`persistLlmUsage()` resolves the complete record first (`findCompleteByInputHash`); on a hit it does not write a new version.

### Aggregation & cost semantics

`aggregateForRun(config)` (`src/artifacts/usage.ts`) reads every `llmUsage` record for the run via `store.listAll()` and sums:

- token totals (defined fields only),
- `costUsd` **only over records that report it** — a run where no provider reported cost yields `llmCostUsd: undefined`, never `0` (which would look like "free"),
- per-model breakdown `llmModels: { [model]: { requests, promptTokens, completionTokens, totalTokens, costUsd } }`.

### Relationship to run diagnostics & Sheets

The publisher node attaches the aggregate to `diagnostics.llmUsage` and writes the six scalar columns into the Google Sheets row (`A:Q`, columns 11-16: Prompt/Completion/Total/Reasoning/Cached tokens + Cost USD). The per-model breakdown stays in the persisted aggregate and `diagnostics.llmUsage.llmModels` only — it is not mirrored into Sheets.

Reconciliation chain: individual `llmUsage` records → `aggregateForRun` → `diagnostics.llmUsage` → Sheet cells. `persistLlmUsage` and `aggregateForRun` never throw; aggregation is best-effort and returns `undefined` when storage is unavailable.

### Behavior when the artifact store is disabled

**LLM usage accounting is unavailable when the artifact store is disabled.** `persistLlmUsage` is a silent no-op (no store, no runId, or no usage). This is intentional — usage tracking is store-backed and non-blocking; it can never fail or slow a video generation.

## Telemetry

`AgentResult.telemetry` carries artifact info alongside existing fields:

```ts
{
  ...,
  fromCache: boolean,
  artifactRef?: { artifactId, type, version, runId },
}
```

`fromCache: true` with `durationMs: 0` means no LLM call happened.

## Error Handling

- A corrupt artifact file (`latest()` returns null) is treated as a miss — the node
  recomputes and rewrites the version. No crash.
- A store write failure is caught and swallowed in `runWithArtifactCache` /
  `cacheNodeResult` — the pipeline continues with the freshly computed result,
  degraded to no-persistence.
- Storage is best-effort; the pipeline never fails because persistence failed.

## Extension Points

- **Other backends** — implement the `ArtifactStore` interface (`src/artifacts/store.ts`)
  for S3/R2/Postgres and inject via `configurable.artifactStore`.
- **Manual editing / approvals** — mark an artifact `invalid` to force recompute, or
  `superseded` to route around a known-bad version; `invalidateArtifact(config, nodeName)`
  is exported for that.
- **Diffing** — each type's versions are sequential JSON records; compare `vN` vs `vN-1`
  to see exactly what changed between retries.
- **Dashboard** — read `manifest.json` + `state/execution.json` to render run status
  without replaying the pipeline.

## Resume from Artifacts

A run that stopped mid-pipeline (dev server crash, thread lost, etc.) can be resumed from
the last completed artifact without re-running prior nodes:

```bash
pnpm --filter youtube-shorts-orchestrator resume <namespace|topic> [--pillar <pillar>] [--topic <topic>]
```

The CLI (`scripts/resume.mjs`):

1. Resolves the run folder (exact name or topic substring).
2. Reads `run.json` for the original `project` input (pillar + topic) and original `threadId`.
3. Reports per-stage status from `manifest.json`; refuses if `publish` is already complete.
4. **Creates a fresh LangGraph thread**, records the new `threadId` in `run.json.threadHistory` (fail-closed: if recording fails the resume aborts before the run starts), and passes `configurable.runId=<namespace>` to replay into the same run folder.
5. Streams the run via the dev API; all completed nodes hit the artifact cache (`fromCache: true`, zero LLM/provider cost); the first missing artifact computes fresh; the graph's guards fast-forward to it automatically.
6. On failure, the thread stays recorded in `threadHistory` as an attempted resume.

**Dry-run** (`--dry-run`): prints status without running.

**Legacy runs** without `run.json` require **both** `--pillar` and `--topic` (the topic is not reliably derivable from the folder name). Without pillar, ResearchAgent cannot hit its cache and will re-generate.

### Important: Dev-Server Checkpointer is Ephemeral

The `langgraph dev` server uses a `MemorySaver` checkpointer synced to `.langgraph_api/.langgraphjs_api.checkpointer.json` with a **3-second debounced flush**. Threads are lost if:

- The process dies before a flush (last checkpoints lost).
- The file is unreadable at startup — `initialize()` silently resets to `{}` (all threads gone).
- Multiple `langgraph dev` instances run concurrently — each has its own MemorySaver copy racing writes to the same file; last-writer-wins.

**The `runs/` artifact store is the durable source of truth.** Do not run two dev servers against the same `runs/` directory. The resume CLI creates a fresh thread and replays from the last cached artifact using `configurable.runId`, making the run visible again in Studio.

## Key Files

- `src/artifacts/types.ts` — schemas: ArtifactRecord, ArtifactMeta, Manifest, CacheKey.
- `src/artifacts/store.ts` — `ArtifactStore` interface.
- `src/artifacts/fs/fs-artifact-store.ts` — filesystem implementation + manifest management.
- `src/artifacts/cache.ts` — `runWithArtifactCache`, `cacheNodeResult`, `completeArtifactForNode`.
- `src/artifacts/context.ts` — store/runId resolution, `completeArtifact`, `invalidateArtifact`.
- `src/artifacts/registry.ts` — artifact type → node → zod schema map.
- `src/artifacts/usage.ts` — `persistLlmUsage`, `aggregateForRun` (LLM usage accounting).
- `src/models/usage.ts` — `normalizeUsage`, `aggregateUsage`, LLM usage types.
- `src/agents/run-agent.ts` — interception point for all LLM agents.
- `src/utils/config.ts` — `artifactStoreEnabled()`, `artifactStoreDir()`.
