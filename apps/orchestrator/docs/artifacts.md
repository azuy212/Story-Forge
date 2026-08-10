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
  manifest.json                      # per-type index: latest version + version list
  artifacts/<type>/v1.json           # versioned artifact records
  artifacts/<type>/v2.json
  state/execution.json               # { "<type>@v<version>": ArtifactReference, ... }
  assets/                            # (future) binary sidecars
  logs/
```

All writes are atomic (`writeFile` to `.tmp` + `rename`). Saves never overwrite — each
write appends a new version.

## Run IDs

A run's identity resolves in priority order:

1. `config.configurable.runId`
2. `config.configurable.thread_id`
3. `state.execution.runId`

A fresh run with no id gets a new UUID via `ensureRunId()`. Re-running with the same
`runId` (e.g. a CLI `--runId` flag or a stored thread id) resumes the same artifact
history, so previously completed steps are served from cache.

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

## Key Files

- `src/artifacts/types.ts` — schemas: ArtifactRecord, ArtifactMeta, Manifest, CacheKey.
- `src/artifacts/store.ts` — `ArtifactStore` interface.
- `src/artifacts/fs/fs-artifact-store.ts` — filesystem implementation + manifest management.
- `src/artifacts/cache.ts` — `runWithArtifactCache`, `cacheNodeResult`, `completeArtifactForNode`.
- `src/artifacts/context.ts` — store/runId resolution, `completeArtifact`, `invalidateArtifact`.
- `src/artifacts/registry.ts` — artifact type → node → zod schema map.
- `src/agents/run-agent.ts` — interception point for all LLM agents.
- `src/utils/config.ts` — `artifactStoreEnabled()`, `artifactStoreDir()`.
