# YouTube Shorts AI Pipeline

Modular LangGraph TypeScript pipeline that transforms a topic pillar into a published video. 22 agents run in sequence with conditional loops — from topic planning through platform publishing.

## Pipeline

```
START
  ↓
ResearchAgent        — LLM: structured research (facts, summary, sources)
  ↓
ResearchQA           — LLM: fact verification gate — per-fact keep/remove/revise verdicts (retry loop)
  ↓
StoryPlanner         — LLM: story beats with viewer questions
  ↓
ScriptWriter         — LLM: script, narration, CTA, estimated duration
  ↓
ScriptQA             — LLM: quality gate — approves or requests rewrite (retry loop)
  ↓
VisualDirector       — LLM: timed scene breakdown + visual plan per scene (camera shot, motion, transition)
  ↓
ImagePromptGenerator — LLM: sceneType-adapted generation prompts
  ↓
PromptQA             — LLM: quality gate — approves or requests re-prompt (retry loop)
  ↓
AssetGenerator       — provider: calls image/video generation provider (stub)
  ↓
NarrationGenerator   — provider: TTS synthesis (stub → ElevenLabs)
  ↓
SubtitleGenerator    — scene-bounded caption timing from scene narration + measured durations
  ↓
VideoComposer        — provider: final video assembly with audio + subtitles (stub → PalmierPro)
  ↓
ReleaseValidation    — deterministic gate: structural + FFprobe media validation
  ↓
ReleaseReview        — LLM: release review of text metadata
  ↓
MetadataGenerator    — LLM: YouTube title, description, tags, hashtags, category, pinned comment
  ↓
ThumbnailGenerator   — LLM + provider: thumbnail prompt strategy + image generation
  ↓
Publisher            — provider: upload to YouTube (and other platforms) with metadata (YouTube auto-picks the Shorts frame; custom thumbnails aren't uploaded)
  ↓
END
```

## Example Output

Given input `{ pillar: "Geography", topic: "Unrecognized Countries" }`, the pipeline produces:

```json
{
  "title": "5 Countries That Don't Exist on Any Map",
  "hook": "These places are real, but no UN member recognizes them...",
  "script": "What if a country officially wasn't real?...",
  "narration": "5 Countries That Don't Exist. These places are real...",
  "estimatedDurationSeconds": 52,
  "callToAction": "Subscribe for more hidden geography",
  "scenes": [
    {
      "sceneId": 1,
      "durationSeconds": 6,
      "sceneType": "satellite",
      "emphasis": "medium",
      "visualDescription": "Satellite view of Eastern Europe at night",
      "narration": "What if a country officially wasn't real?",
      "generationPrompt": "Ultra detailed satellite view of Moldova at night. Cold blue tone. Documentary style. No text.",
      "assetType": "image",
      "promptId": "prompt-scene-001",
      "assetId": "asset-scene-001",
      "provider": "gpt-image",
      "generationMode": "generate",
      "filename": "scene-001.png",
      "extension": "png"
    }
  ]
}
```

## Current State

**Runnable** with mock or real LLM responses. All LLM agents use OpenRouter. Produces a complete video from topic planning through composition — providers beyond the stubs (ElevenLabs TTS, PalmierPro MCP) require real credentials.

### Input Contract

| Field                     | Required | Type     | Example                                        | Notes                                                                         |
| ------------------------- | -------- | -------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `project.pillar`          | yes      | string   | `"Geography"`                                  | High-level category                                                           |
| `project.topic`           | yes      | string   | `"Unrecognized Countries"`                     | Specific angle                                                                |
| `branding.channel`        | no       | string   | `"Universe Decoded by Zain"`                   | Channel name                                                                  |
| `branding.handle`         | no       | string   | `"@UniverseDecodedByZain"`                     | Channel handle                                                                |
| `branding.creator`        | no       | string   | `"Ali Zain"`                                   | Creator name                                                                  |
| `branding.cta`            | no       | string   | `"Follow for more mysteries of the universe."` | Deterministic CTA configuration                                               |
| `branding.enabled`        | no       | boolean  | `true`                                         | Enable canonical outro                                                        |
| `branding.outroAsset`     | no       | string   | `"assets/branding/outro.mp4"`                  | Relative repository asset path                                                |
| `branding.outroLongAsset` | no       | string   | `"assets/branding/outro-long.mp4"`             | Outro used for long-form (16:9) videos; falls back to `outroAsset` when unset |
| `branding.ctaEnabled`     | no       | boolean  | `true`                                         | Render CTA when outro lacks one                                               |
| `branding.style`          | no       | string   | `"Documentary"`                                | Visual style guide                                                            |
| `branding.colorPalette`   | no       | string   | `"Cold blue"`                                  | Color theme                                                                   |
| `branding.logo`           | no       | string   | `"UD logo"`                                    | Logo reference                                                                |
| `branding.voice`          | no       | string   | `"en-US-Neural2-F"`                            | TTS voice                                                                     |
| `branding.platforms`      | no       | string[] | `["youtube"]`                                  | Target publish platforms                                                      |
| `execution.version`       | yes      | string   | `"0.1.0"`                                      | Pipeline version                                                              |

`branding/brand.json` owns default branding values. Relative media paths are
resolved centrally by walking from process working directory toward repository
root; commands must run from orchestrator package or workspace root.

### Implemented

| Component                                    | Type                 | Status   |
| -------------------------------------------- | -------------------- | -------- |
| ResearchAgent                                | LLM agent            | complete |
| ResearchQA                                   | LLM gate             | complete |
| StoryPlanner                                 | LLM agent            | complete |
| ScriptWriter                                 | LLM agent            | complete |
| ScriptQA                                     | LLM gate             | complete |
| VisualDirector                               | LLM agent            | complete |
| ImagePromptGenerator                         | LLM agent            | complete |
| PromptQA                                     | LLM gate             | complete |
| AssetGenerator                               | provider             | complete |
| NarrationGenerator (TTS)                     | provider             | complete |
| SubtitleGenerator                            | provider             | complete |
| VideoComposer                                | provider             | complete |
| ReleaseValidation                            | deterministic gate   | complete |
| ReleaseReview                                | LLM gate             | complete |
| MetadataGenerator                            | LLM agent            | complete |
| ThumbnailGenerator                           | LLM + provider       | complete |
| Publisher                                    | provider             | complete |
| `runAgent()` harness                         | shared               | complete |
| Prompt cache (in-memory)                     | utility              | complete |
| Shared editorial guidelines                  | prompt infra         | complete |
| Completeness validation                      | ImagePromptGenerator | complete |
| Gemini instruction filter                    | PromptQA             | complete |
| `singleAttempt` option                       | runAgent             | complete |
| Telemetry (model, tokens, retries, versions) | per-node             | complete |
| Zod schema validation                        | all outputs          | complete |
| Dependency injection for tests               | all agents           | complete |
| Provider interface + stub pattern            | all providers        | complete |
| FFprobe media validation                     | ReleaseValidation    | complete |
| SRT parsing (monotonic, overlap, bounds)     | ReleaseValidation    | complete |
| Unit tests                                   | 237                  | passing  |
| Integration test                             | 8                    | passing  |

### Not Implemented

| Component                      | Notes                                                      |
| ------------------------------ | ---------------------------------------------------------- |
| Provider adapters (production) | GPT Image, Runway, ElevenLabs, PalmierPro need credentials |
| Orchestration layer            | Parallel execution, caching, progress tracking             |
| Configurable provider map      | `ASSET_CONFIG` hardcoded in asset-generator                |
| ResearchCollector agent        | Enum entry, no node                                        |
| PromptEngineer agent           | Enum entry, no node                                        |
| NarrationPlanner agent         | Enum entry, no node                                        |
| QAReviewer agent               | Enum entry, no node                                        |

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm
- OpenRouter API key (for real LLM calls)

### Setup

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env — add OPENROUTER_API_KEY
```

### Network runtime (IPv4-only sockets)

Google OAuth (`oauth2.googleapis.com`) fails with bare `ETIMEDOUT` on hosts
without a working IPv6 route when Node's Happy Eyeballs auto-selection races
an unroutable AAAA. DNS ordering alone (`--dns-result-order=ipv4first`) does
not fix this.

The orchestrator centralizes the fix in `src/runtime/network.ts` (TypeScript)
and `src/runtime/network.mjs` (plain-JS scripts):

```ts
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);
```

Every Google-enabled entrypoint loads this before creating `googleapis` /
`google-auth-library` clients (graph bootstrap, OAuth factory, Sheets client,
YouTube client, and all `scripts/*.mjs` that talk to Google). Do not hard-code
Google IPs; do not reintroduce custom token-exchange HTTPS; do not rely solely
on `NODE_OPTIONS=--dns-result-order=ipv4first`.

Diagnostics (no secrets printed):

```bash
pnpm exec node scripts/test-google-network.mjs   # DNS / IPv4 TCP / HTTPS / fetch
pnpm exec node scripts/test-google-auth.mjs      # OAuth2Client.getAccessToken()
```

### Scene-Bounded Narration and Subtitles

`production.scenes[].narration` is authoritative. NarrationGenerator creates
one TTS artifact per scene, preserves numeric scene ordering, then concatenates
those files with FFmpeg without inserting silence or changing playback speed.
SubtitleGenerator creates cues from the same scene narration and measured scene
audio durations. Cues never cross scene boundaries.

**Complete-narration mode** (`NARRATION_GENERATION_MODE=complete`, the OpenRouter
TTS default) synthesizes the whole narration in a single audio file; per-scene
durations are word-count-proportional estimates with no per-scene audio files.

> Note: subtitle timing is scene-bounded **proportional caption timing** — words
> are distributed uniformly across the measured scene duration. It is
> deterministic and needs no alignment service, but it is not waveform word
> alignment.

> Note: in real-provider mode (`USE_REAL_PROVIDERS=true`) the WhisperX scene
> subtitle provider aligns actual audio instead: it aligns each scene's audio in
> scene mode, or the single combined narration audio in complete mode, and
> builds cues from the returned word timestamps. Only a WhisperX failure falls
> back to the deterministic timing above.

> Note: scene-audio cache identity includes the TTS provider's
> `cacheFingerprint()`. Chatterbox's fingerprint is a **deployment contract**:
> bump `CHATTERBOX_CACHE_VERSION` in `chatterbox-tts-provider.ts` whenever the
> server-side model/voice pipeline changes, or cached scene audio can go stale.

### TTS Providers

Narration audio is produced by a `TTSProvider` selected via environment config
(see [Environment](#environment) below). The generic interface is
`src/providers/tts-provider.ts` (`synthesize({ text, voice?, filename?, ... })`
→ `{ audioUrl, durationMs }`); it contains no provider-specific concepts.
Providers persist audio to disk (FFmpeg concat requires local files).

| Provider                | `TTS_PROVIDER`         | Backend                                          | Output    |
| ----------------------- | ---------------------- | ------------------------------------------------ | --------- |
| `ChatterboxTTSProvider` | `chatterbox` (default) | Local service on `TTS_URL` (port 8010)           | WAV       |
| `OpenRouterTTSProvider` | `openrouter`           | `POST https://openrouter.ai/api/v1/audio/speech` | MP3 → WAV |

`OpenRouterTTSProvider` treats OpenRouter as the TTS gateway: the configured
`OPENROUTER_TTS_MODEL` names the actual TTS model (currently the Fish Audio
model `fish-audio/s2.1-pro-free`; the provider does not know or care that the
model is Fish Audio). It POSTs `{ model, input, voice?, response_format? }`,
requires no JSON on the responsive OK body (raw audio bytes are written to the
output file atomically via temp-file + rename), retries transient failures
(429, 5xx, network/timeouts) with exponential backoff, and aborts on timeout.
Non-2xx JSON errors (`error.message`) are surfaced for diagnosis. The audio is
re-encoded to WAV via FFmpeg so downstream concat/alignment only ever sees the
same format Chatterbox produces. The pipeline's generic voice default
(`"narrator"`) is never forwarded — only a configured `OPENROUTER_TTS_VOICE` or
an explicitly passed non-default voice is sent, since Fish Audio rejects
generic voice names with HTTP 400.

Voice and response format are provider/model-specific configuration, not part
of the generic TTS contract:

```env
TTS_PROVIDER=openrouter
OPENROUTER_TTS_MODEL=fish-audio/s2.1-pro-free
OPENROUTER_TTS_VOICE=536d3a5e000945adb7038665781a4aca
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
```

Adding another OpenRouter TTS model (e.g. `fish-audio/s2.1-pro` or any model
behind OpenRouter's `/api/v1/audio/speech`) requires only a config change —
no provider code change.

```text
VisualDirector / AssetGenerator
   ↓ production.scenes[].narration
NarrationGenerator
   ↓ scene-001.wav, scene-002.wav, ...
FFmpeg ordered concat → combined narration.wav
   ↓
SceneSubtitleProvider → SRT / ASS
   ↓
VideoComposer
```

Audio state contains both scene and combined artifacts:

```json
{
  "version": 2,
  "scenes": [
    {
      "sceneId": 1,
      "artifactId": "...",
      "narration": "...",
      "durationMs": 4520,
      "url": "..."
    }
  ],
  "combinedAudio": {
    "artifactId": "...",
    "durationMs": 54910,
    "url": "...",
    "sourceSceneArtifactIds": ["..."]
  }
}
```

The standalone transcriber service remains available for independent alignment
experiments, but is not invoked by the production LangGraph narration path.

### Run Tests

```bash
# Unit tests (237 tests, no API key needed — uses DI mocks)
pnpm test

# Integration test (end-to-end graph with mock LLM responses)
pnpm test:int

# Type check
pnpm typecheck

# Lint
pnpm lint
```

### Run Pipeline

```bash
# 1. Start LangGraph dev server
npx @langchain/langgraph-cli dev

# 2. Open playground at http://localhost:2024
#    Paste input: {"project":{"pillar":"Geography","topic":"Unrecognized Countries"},"branding":{"channel":"GeoFacts","creator":"","cta":"Subscribe"},"execution":{"version":"0.1.0"}}

# For direct graph invocation, use LangGraph Studio or import `graph` from `src/graph/index.ts`.
```

**Without an API key** — all agents support dependency injection. See tests for mock patterns. Set `OPENROUTER_API_KEY` to any value + mock the `createModel` function via `configurable`.

## Seed-Driven Runs (Pre-Written Research / Script)

When you already have research (or a finished script) and want to skip the LLM
research/script producers, pass them as **seed channels** alongside
`project`. The graph's `entryRouter` (`src/graph/index.ts`) detects them and
jumps past the producers that would regenerate them:

- `research` + `content.script` present → VisualDirector (skips
  ResearchAgent, ResearchQA, ScriptPlanner, ScriptWriter, ScriptQA)
- `research` only → ScriptPlanner (skips ResearchAgent + ResearchQA)
- otherwise → full normal flow

The `seed-run` launcher handles thread creation, run-folder naming, and SSE
streaming. Two seed forms are supported, auto-detected by extension and shape
(override with `--convert` / `--no-convert`):

| Mode             | Seed file                                                        | Behavior                                                                                                                            |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Structured       | `.json` with `research.{summary,facts}` + `content.{script,...}` | Validated and fed to the graph. **No LLM convert call.** `pillar` + `topic` are required (in the file or via `--pillar`/`--topic`). |
| Text / paragraph | `.txt` / `.md`, or `.json` with string `research` / `script`     | LLM (using `SEED_CONVERT_PROMPT`) structures it, including `pillar` + `topic` when not supplied. Requires `OPENROUTER_API_KEY`.     |

### Sheet writeback

Publish records land on a dedicated **`Seed Runs`** sheet (override with
`GOOGLE_SHEETS_SHEET_NAME_SEED`), never on the run-next backlog sheets
(`Sheet1` / `Long Videos`). To match an existing row in the `Seed Runs` tab,
pass `--project-id <that row's Video ID>`. Without it, the publish result is
logged but not written to the sheet.

### Examples

```bash
# Structured JSON
pnpm seed-run --seed ./my-seed.json

# Plain-text research notes (LLM converts + writes a script)
pnpm seed-run --seed ./notes.txt \
  --pillar Psychology \
  --topic "Why Your Brain Remembers Things That Never Happened"

# Force LLM conversion on a partial JSON
pnpm seed-run --seed ./partial.json --convert

# Validate without running
pnpm seed-run --seed ./my-seed.json --dry-run
```

### Structured seed shape

```json
{
  "pillar": "Psychology",
  "topic": "Why Your Brain Remembers Things That Never Happened",
  "videoProfile": "short",
  "research": {
    "summary": "One-paragraph brief.",
    "facts": [
      {
        "id": "f1",
        "fact": "...",
        "confidence": "high",
        "classification": "study"
      }
    ]
  },
  "content": {
    "script": "Full narration text.",
    "title": "Optional short title",
    "ending": { "type": "twist", "narration": "Optional payoff line" }
  }
}
```

`content.narration` defaults to `content.script` when omitted. See
`pnpm seed-run --help` for the full option list.

## How It Works

### Data Flow

Each step enriches the shared graph state. Agents are gated by quality-check nodes (ResearchQA, ScriptQA, PromptQA, ReleaseValidation, ReleaseReview) that can trigger retry loops.

```
Step  1 — ResearchAgent
  Reads:  project.pillar, project.topic
  Writes: research.summary, research.facts[]

Step  2 — ResearchQA (retry loop → ResearchAgent)
  Reads:  research.facts, research.summary
  Writes: researchQA.{status, feedback, factsToRegenerate, factVerdicts[]}
          on approval merges verified + reason into research.facts[]

Step  3 — ScriptPlanner
  Reads:  research
  Writes: content.{title, hook}, storyPlan.{storySummary, storyBeats[]}

Step  4 — ScriptWriter
  Reads:  content.title, content.hook, storyPlan
  Writes: content.script, content.narration, content.callToAction,
          content.estimatedDurationSeconds

Step  5 — ScriptQA (retry loop → ScriptWriter)
  Reads:  content.script
  Writes: scriptQA.{status, feedback}

Step  6 — VisualDirector
  Reads:  content.narration, content.script, content.estimatedDurationSeconds
  Writes: production.scenes[].{sceneId, startSecond, endSecond, durationSeconds,
          narration, visualDescription, sceneType, cameraShot, cameraMotion,
          transition, emphasis, assetType, references},
          production.visualPlan[]

Step  7 — ImagePromptGenerator
  Reads:  production.scenes[], project, branding
  Writes: production.scenes[].{generationPrompt, promptId, assetType}

Step  8 — PromptQA (retry loop → ImagePromptGenerator minor / VisualDirector major)
  Reads:  production.scenes[].generationPrompt
  Writes: production.promptQA.{status, globalFeedback, sceneResults[]}

Step  9 — AssetGenerator (provider)
  Reads:  production.scenes[] (must have generationPrompt)
  Writes: production.scenes[].{assetId, provider, generationMode, filename,
          extension, assetUrl, assetGeneratedAt}

Step 10 — NarrationGenerator (provider TTS)
  Reads:  production.scenes[].{sceneId, narration}
  Writes: audio.{version, scenes[], combinedAudio, narrationUrl,
          narrationDurationMs, voice, generatedAt}

Step 11 — SubtitleGenerator (provider)
  Reads:  audio.scenes[], audio.combinedAudio, production.scenes[]
  Writes: subtitles.{srt, ass, wordTimestamps, generatedAt}

Step 12 — VideoComposer (provider)
  Reads:  production.scenes[].{assetUrl, startSecond, endSecond, durationSeconds},
          audio.combinedAudio, audio.scenes[], subtitles.srt,
          content.estimatedDurationSeconds, branding
  Writes: video.{videoUrl, durationMs, resolution, composedAt}

Step 13 — ReleaseValidation (deterministic gate)
  Reads:  content, audio, subtitles, video, production.scenes, metadataOutput, thumbnail
          + FFprobe of videoUrl (duration, resolution, fps, streams)
  Writes: releaseValidation.{status, issues, validations}
          status "fatal" halts the graph before publishing

Step 13b — ReleaseReview (LLM)
  Reads:  content.{title, hook, narration}, thumbnail.thumbnailText, metadataOutput, branding
  Writes: releaseReview.{status, issues}
          status "fatal" halts the graph before publishing

Step 14 — MetadataGenerator (LLM)
  Reads:  content.title, content.hook, content.narration, branding
  Writes: metadataOutput.{title, description, tags, hashtags, category, pinnedComment}

Step 15 — ThumbnailGenerator (LLM + provider)
  Reads:  content.title, content.hook, content.narration, branding
  Writes: thumbnail.{thumbnailPrompt, thumbnailText, textPosition, colorScheme, imageUrl, generatedAt}

Step 16 — Publisher (provider)
  Reads:  video.videoUrl, metadataOutput, thumbnail.imageUrl, branding.platforms
  Writes: publishing.{results[], publishedAt}
```

MetadataGenerator/ThumbnailGenerator branch off the spine in parallel and join
at Publisher; if the spine dies at a QA gate, the branch work is discarded.

### Agents

Every LLM agent calls `runAgent()` — a single harness that:

1. Loads prompt file from `prompts/` (with in-memory cache)
2. Splits on `\n---\n` into system + user message
3. Renders `{{variable}}` placeholders
4. Appends shared editorial guidelines to system prompt
5. Invokes model via OpenRouter with `json_object` response format
6. Retries on invalid JSON or schema failure (configurable via `maxRetries` / `singleAttempt`)
7. Validates output with Zod schema
8. Returns typed data + telemetry

### Prompt File Format

```
prompts/research-agent/v1.md:

You are a research assistant...
---
Given the pillar "{{pillar}}" and topic "{{topic}}", produce:
- A one-paragraph summary
- At least 8 facts, each with id, confidence, and sourceType
```

System prompt before `---`, user prompt after. Variables use `{{double curlies}}`.

### Retry Architecture

```
LLM agents (ResearchAgent, ScriptWriter, VisualDirector, ImagePromptGenerator):
  runAgent(maxRetries=3) — transport retry (invalid JSON, schema failures)

QA loops (ResearchQA, ScriptQA, PromptQA):
  approved → proceed; minor/major_revision → re-run producer until retries exhausted

ImagePromptGenerator:
  outer loop (maxAttempts=2) — semantic retry (completeness validation)
    └── runAgent(singleAttempt=true) — 1 LLM call per outer iteration

AssetGenerator / NarrationGenerator / SubtitleGenerator / VideoComposer (deterministic providers):
  no LLM retry
```

### IDs

| Field      | Format                            | Source                              |
| ---------- | --------------------------------- | ----------------------------------- |
| `promptId` | `prompt-scene-NNN`                | ImagePromptGenerator                |
| `assetId`  | `asset-scene-NNN`                 | AssetGenerator (deterministic fold) |
| `filename` | `scene-NNN.png` / `scene-NNN.mp4` | AssetGenerator (deterministic fold) |

### Providers

| Asset Type | Default Provider | Extension |
| ---------- | ---------------- | --------- |
| image      | gpt-image        | png       |
| video      | runway           | mp4       |

Defined in `src/agents/asset-generator.node.ts` — deterministic provider map. Provider is overridable per-scene.

## Project Structure

```
src/
  agents/
    research-agent.node.ts           — structured research
    research-qa.node.ts              — fact verification gate (per-fact verdicts)
    script-planner.node.ts           — title/hook + story beats
    script-writer.node.ts            — script, narration, CTA, duration
    script-qa.node.ts                — script quality gate
    visual-director.node.ts          — timed scene breakdown + visual plans
    image-prompt-generator.node.ts   — generation prompts per scene
    prompt-qa.node.ts                — prompt quality gate
    asset-generator.node.ts          — image/video generation provider
    narration-generator.node.ts      — per-scene TTS synthesis + FFmpeg ordered concat
    subtitle-generator.node.ts       — scene-bounded deterministic caption timing
    video-composer.node.ts           — final video assembly provider
    release-validation.node.ts       — deterministic structural & media gate
    release-review.node.ts           — LLM release review (text metadata)
    metadata-generator.node.ts       — YouTube title, description, tags, category
    thumbnail-generator.node.ts      — thumbnail prompt + image generation
    publisher.node.ts                — multi-platform publish provider
    run-agent.ts                     — shared LLM harness
  graph/
    index.ts                         — StateGraph wiring + conditional edges
    state.ts                         — Annotation.Root + merge reducers
  schemas/
    project-state.ts                 — full state schema
    production.ts                    — Scene, ProviderEnum, GenerationModeEnum
    audio.ts                         — Audio schema
    subtitles.ts                     — Subtitles schema
    video.ts                         — Video schema
    branding.ts                      — channel, creator, style, cta, platforms
    diagnostics.ts                   — NodeTelemetry
    image-prompt-output.ts           — ImagePromptGenerator output
    thumbnail.ts                     — Thumbnail state schema
    thumbnail-output.ts              — ThumbnailGenerator LLM output
    publishing.ts                    — PublishResult + Publishing schemas
    ...                             — other agent output schemas
  models/
    agent-model.ts                   — AgentModel enum
    model-factory.ts                 — OpenRouter client factory
    prompt-paths.ts                  — typed prompt path map
  providers/
    composer-provider.ts             — ComposerProvider interface
    stub-composer-provider.ts        — stub for tests
    palmierpro-composer-provider.ts  — PalmierPro MCP adapter
    subtitle-provider.ts             — SubtitleProvider interface (legacy)
    stub-subtitle-provider.ts        — stub for tests
    scene-subtitle-provider.ts       — DeterministicSceneSubtitleProvider (production)
    whisperx-provider.ts             — WhisperX HTTP client (:8030 /align, standalone experiments)
    whisperx-subtitle-provider.ts    — WhisperX-backed SubtitleProvider (not used by production graph)
    asset-provider.ts                — AssetProvider interface
    stub-asset-provider.ts           — stub for tests
    tts-provider.ts                  — TTS provider interface
    stub-tts-provider.ts             — stub for tests
    chatterbox-tts-provider.ts       — Chatterbox TTS (local service on TTS_URL)
    openrouter-tts-provider.ts       — OpenRouter /api/v1/audio/speech TTS
    tts-fingerprint.ts               — canonical TTS cache identity
    publisher-provider.ts            — PublisherProvider interface
    stub-publisher-provider.ts       — stub for tests
  story/                             — Story-Forge stickman pipeline (isolated from src/graph)
    index.ts                         — public entry point
    run.ts                           — S1–S8 orchestrator, resume, review gate
    agents.ts                        — five story LLM calls behind one injectable interface
    config.ts                        — STORY_* / CLI configuration resolution
    input.ts                         — input validation + deterministic job id
    paths.ts                         — jobs/<jobId>/ artifact layout
    manifest.ts                      — fingerprinted stages + resume lifecycle
    atomic.ts                        — atomic JSON/text writes
    types.ts                         — Zod schemas + data contracts
    sentences.ts                     — script-aware sentence segmentation
    style-profile.ts                 — image style profile loader
    prompt.ts                        — image prompt composition + prompt lint
    lint.ts                          — reading-level lint + hard-word gate
    alignment.ts                     — script↔ASR token alignment
    subtitles.ts                     — sentence-aware cue building (ASS + SRT)
    timing.ts                        — measured, frame-snapped scene timeline
    images.ts                        — per-scene image stage + DP4 gates
    audio.ts                         — per-scene TTS chunks + master narration
    media.ts                         — ffprobe duration/loudness helpers
    ffmpeg-args.ts                   — FFmpeg argument construction (pure)
    render.ts                        — single-pass render + output validation
    runner.ts                        — stage runner (fingerprint + atomic resume)
  utils/
    scene-id.ts                      — padSceneId helper
    subtitle-format.ts               — SRT/ASS timestamp formatting
    config.ts                        — env var gateway
    errors.ts                        — PipelineError, LLMError, duck-type guards
    load-prompt.ts                   — file I/O with cache
    render-prompt.ts                 — {{variable}} interpolation
    logger.ts                        — structured JSON logger
  types/
    index.ts                         — re-exports
prompts/
  shared/editorial-guidelines.md    — auto-injected into every agent
  research-agent/v1.md
  research-qa/v1.md
  script-planner/v1.md
  script-writer/v1.md
  script-qa/v1.md
  visual-director/v1.md
  image-prompt-generator/v1.md
  prompt-qa/v1.md
  metadata-generator/v1.md
  thumbnail-generator/v1.md
  release-review/v1.md
  story-story/v1.md                 — story writer (topic → story + claims ledger)
  story-verify/v1.md                — claims-ledger verification gate
  story-scenes/v1.md                — sentence→scene grouping
  story-characters/v1.md            — character registry
  story-slots/v1.md                 — per-scene visual slots
  story/style/stickman-history.json — image style profile (template + constraints)
tests/
  graph.int.test.ts                 — end-to-end integration (8 scenarios)
  agent.test.ts                     — runAgent harness
  research-agent.test.ts
  research-qa.test.ts
  script-writer.test.ts
  script-qa.test.ts
  image-prompt-generator.test.ts
  prompt-qa.test.ts
  asset-generator.test.ts
  narration-generator.test.ts
  subtitle-generator.test.ts
  video-composer.test.ts
  release-validation.test.ts
  release-review.test.ts
  metadata-generator.test.ts
  thumbnail-generator.test.ts
  publisher.test.ts
  artifact-cache.test.ts
  fs-artifact-store.test.ts
  normalize.test.ts
  chatterbox-tts-provider.test.ts
  openrouter-tts-provider.test.ts
  image-provider-asset-provider.test.ts
  story-sentences.test.ts           — segmentation, grouping, narration assembly
  story-alignment.test.ts           — tokenizer, numeric spans, LCS, fallback
  story-subtitles.test.ts           — cue splitting, wrapping, ASS/SRT output
  story-timing.test.ts              — cumulative frame boundaries
  story-lint.test.ts                — word budget + hard-word gate
  story-prompt.test.ts              — prompt composition, lint, style profiles
  story-ffmpeg-args.test.ts         — concat list, render args, filter graph
  story-manifest.test.ts            — fingerprints, resume, atomic writes
  story-resume.test.ts              — frozen-config resume: stored values win, changed flags fail
  story-config.test.ts              — config precedence, input validation, paths
  story-prompts.test.ts             — prompt files render with the agent variables
  story-shared-edits.test.ts        — one regression per shared-code change
```

## Story-Forge Stickman Storytelling Pipeline

A second, self-contained pipeline that turns a **topic** into a **validated 1080p
MP4** with hand-drawn stickman illustrations, per-scene narration, and
audio-timed subtitles. It shares the LLM harness, providers, and FFmpeg helpers
with the Shorts graph but never touches `src/graph/**` or any agent node — all
of its code lives in `src/story/`, its prompts in `prompts/story-*/`, and its
entry point in `scripts/story-video.mjs`.

### One Command

```bash
pnpm --filter youtube-shorts-orchestrator build          # dist/story/index.js is what the CLI runs
pnpm --filter youtube-shorts-orchestrator story "The mutiny on the Bounty" --duration 150
```

```text
job:      the-mutiny-on-the-bounty-7f3a91c4
dir:      /…/apps/orchestrator/jobs/the-mutiny-on-the-bounty-7f3a91c4
status:   complete
video:    /…/jobs/the-mutiny-…/final.mp4
          1920x1080 30fps 151.2s h264/aac
manifest: /…/jobs/the-mutiny-…/manifest.json
```

| Option                             | Default                  | Meaning                                                       |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------- |
| `--duration <s>`                   | `150`                    | target narration length (`STORY_TARGET_DURATION_SEC`)         |
| `--language <tag>`                 | `en`                     | BCP-47 tag; also selects the expected prompt script           |
| `--tone <text>`                    | —                        | narration tone hint                                           |
| `--style <id>`                     | `stickman-history`       | image style profile under `prompts/story/style/`              |
| `--job-id <id>`                    | `slug(topic)-<8 hex>`    | job id **and** output directory name                          |
| `--out-dir <dir>`                  | `apps/orchestrator/jobs` | directory that holds the job folder                           |
| `--wpm <n>`                        | `150`                    | speaking rate used for word budgets and the lint gate         |
| `--fps <n>` / `--resolution <WxH>` | `30` / `1920x1080`       | render grid                                                   |
| `--image-concurrency <n>`          | `1`                      | in-flight image requests                                      |
| `--scene-gap-ms <ms>`              | `200`                    | silence held between scenes (never after the last one)        |
| `--stages <list>`                  | all                      | run only these stages                                         |
| `--from <stage>`                   | —                        | force this stage and every later stage to rerun               |
| `--dry-run`                        | `false`                  | validate the input, print the plan, make no paid call         |
| `--review-story`                   | `false`                  | print the story and wait for approval (`y`) before continuing |
| `--json`                           | `false`                  | print the result summary as JSON                              |

Exit codes: `0` complete **or a successful dry run**, `1` failed, `2` an
incomplete run (some stages are still pending — e.g. `--stages S1_input,S2_story`).

The CLI loads `apps/orchestrator/.env` itself (anchored to the package, like
every other `.mjs` entrypoint here) and configures the IPv4-first network
runtime before importing the compiled pipeline. Nothing under `src/` reads
`.env`, so without this the documented `OPENROUTER_API_KEY` was invisible to the
one-command entry point.

All `STORY_*` environment variables mirror these flags (`STORY_LANGUAGE`,
`STORY_TONE`, `STORY_STYLE`, `STORY_TTS_WPM`, `STORY_VOICE`,
`STORY_IMAGE_CONCURRENCY`, `STORY_RESOLUTION`, `STORY_FPS`, `STORY_SCENE_GAP_MS`,
`STORY_IMAGE_MIN_WIDTH`, `STORY_IMAGE_MIN_HEIGHT`, `STORY_IMAGE_MIN_ASPECT`,
`STORY_IMAGE_MAX_ASPECT`, `STORY_TTS_MAX_CHARS`, `STORY_SUBTITLE_MAX_CHARS_PER_LINE`,
`STORY_SUBTITLE_MIN_DURATION_MS`, `STORY_CRF`, `STORY_PRESET`, `STORY_JOBS_DIR`,
`STORY_PROMPTS_PATH`, `STORY_REVIEW_STORY_TIMEOUT_MS`). `STORY_LLM_MODEL` is a
single story-only model fallback that sits between the per-agent/per-role model
and `DEFAULT_MODEL`. A CLI flag always wins over the environment. Story mode
deliberately does **not** inherit `NARRATION_GENERATION_MODE` or
`TARGET_DURATION_SEC`: scene-bounded chunking is a constant here, not a mode.

### Stages

| Stage            | What it does                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S1_input`       | validate the input, resolve the style profile, record the word budget and the `unverified` grounding source                                                                                                                                                                                                                                  |
| `S2_story`       | `StoryAuthor` writes the story + claims ledger, then a measurable lint gate (sentence length, word budget ±15%, hard words need an in-sentence explanation). One automatic rewrite, then hard fail                                                                                                                                           |
| `S3_scenes`      | `StoryScenePlanner` groups **sentence ids** into scenes; code re-assembles the narration from those ids, so the model can never alter the text                                                                                                                                                                                               |
| `S4_visual_plan` | `StoryCharacterDesigner` builds the character registry, then `StoryVisualPlanner` fills one visual slot set per scene (2 in flight)                                                                                                                                                                                                          |
| `S5_images`      | compose each prompt from the style profile + registry (never model-authored), lint it, generate, and gate the still (≥1000×540, aspect 1.6–1.9)                                                                                                                                                                                              |
| `S6_audio`       | one TTS call per scene (`skipWpmNormalization`, chunks >450 chars split at sentence boundaries), a free unconstrained ASR pass per chunk, one automatic re-synthesis when that pass hears less than 85% of the script (advisory; `STORY_ASR_VERIFY=false` skips it), then an FFmpeg concat of the measured chunks into `audio/narration.wav` |
| `S7_align`       | per-scene transcriber word timings aligned to the script tokens (LCS + numeric spans, proportional fallback); cues and timing are rebuilt from the script, never from ASR text                                                                                                                                                               |
| `S8_render`      | one lossy FFmpeg pass (concat demuxer + Lanczos cover-crop to 1080p + burned subtitles) and the deterministic output validation                                                                                                                                                                                                              |

Four decisions the brief called out:

- **DP1/DP2 — measured audio, not estimates.** Each scene is synthesized
  separately and its real duration is probed, so scene boundaries and subtitle
  timings come from the audio that was actually produced. A scene's still is
  held from `start_i` to `start_{i+1}`, so the inter-scene gap reads as a short
  hold of the previous image. Frame counts come from cumulative boundaries
  (`round(cum × fps)` differences), never per-scene rounding, so drift cannot
  accumulate.
- **DP3 — no research agent, no silent fabrication.** Claims are checked against
  the story's own ledger by `StoryVerifier` (blocking: unsupported events,
  invented quotes/dialogue/motive, unhedged disputed claims) and the manifest is
  written with `groundingSource: "model-knowledge"` and `unverified: true`.
- **DP4 — provider limits are handled, not assumed.** The image gate is
  size/aspect based, the source dimensions are recorded per image, and the
  1080p frame is reached by a Lanczos cover-crop upscale at render time.
- **One encode.** The image sequence goes through the concat demuxer with
  frame-snapped durations, and subtitles are burned in the same pass — there is
  no intermediate lossy file and no second encoding.
- **Validation separates gates from warnings.** Codec, resolution, duration,
  black-frame and silence checks gate completion. The frame-vs-source check is
  a warning: it requires the sampled frame to match its own scene image better
  than any other scene's image by a margin, with the subtitle band masked, and
  its failure is recorded in `manifest.warnings` until the margin has been
  tuned on real illustrations. `blackdetect` is configured for "empty frame"
  (`pix_th=0.05`, `picture_black_ratio_th=0.995`), so a pre-dawn or stormy
  panel is not mistaken for a missing image.

### Subtitles and Fonts

Cues are built from the script's own sentences (never the ASR text), broken at
sentence terminators, and timed from the aligned word timings. The ASS header
plays at 1920×1080 with no `force_style`, and libass is pointed at
`apps/orchestrator/assets/branding/` so the face is pinned instead of resolved
through fontconfig:

- `NotoSans-Bold.ttf` — the style's `Noto Sans` face
- `NotoNaskhArabic-Bold.ttf` — Arabic-script fallback for `--language ur` etc.

Both are unmodified Noto files under the SIL Open Font License 1.1; the licence
travels with them in `assets/branding/LICENSE-OFL-1.1.txt`. Override with
`SUBTITLE_FONT_PATH` / `SUBTITLE_FONT_NAME` if you want a different face.

### Artifacts and Resumability

```text
jobs/<jobId>/
  manifest.json      S1–S8 fingerprints, per-stage metrics, warnings, validations
  story.json  claims.json  characters.json  scenes.json
  images/scene-001.png
  audio/parts/scene-001-part01.wav   audio/chunks/scene-001.wav   audio/narration.wav
  transcript.json    subtitles.ass   subtitles.srt
  render/concat.txt  final.mp4
```

Every artifact is written atomically (temp file + rename). Every stage stores a
fingerprint of its inputs, so a rerun reuses whatever still matches and the job
is complete only once S8 validation passes:

```bash
# resume: nothing is re-called, the job is already complete
pnpm --filter youtube-shorts-orchestrator story "The mutiny on the Bounty" --job-id my-job

# force a rerun from the narration stage onwards, reusing images and chunks
pnpm --filter youtube-shorts-orchestrator story "The mutiny on the Bounty" --job-id my-job --from S6_audio --json
```

A resume **replays the configuration stored in the manifest**. Flags such as
`--duration`, `--wpm`, `--style`, `--language`, `--fps` or `--resolution` are
part of the stage fingerprints, so passing one that disagrees with the manifest
is refused with `STORY_CONFIG_CONFLICT` (and nothing is called or written)
instead of quietly invalidating the fingerprints and re-running paid stages:

```
$ story "…" --job-id my-job --duration 150
Story job failed: Refusing to resume job my-job with changed flags:
--duration (manifest: 45, requested: 150). …
```

Rerun with the stored value, or start a genuinely different run with a new
`--job-id`. `--image-concurrency` and `--out-dir` are the exceptions: they change
how the job runs, not what it produces, so they may change on resume.

### Tests and End-to-End Smoke

```bash
# story unit tests (no API key, no provider calls)
pnpm --filter youtube-shorts-orchestrator exec node --experimental-vm-modules \
  node_modules/jest/bin/jest.js --testPathPatterns=tests/story-

# full pipeline with fake agents and real FFmpeg/ffprobe (real images via lavfi,
# real WAVs via sine): three passes — full job, unchanged resume, forced stages
pnpm --filter youtube-shorts-orchestrator build
node apps/orchestrator/scripts/story-smoke.mjs
```

The smoke script proves resumability by counting provider calls (pass 2 makes
none; pass 3 reuses every image, chunk, and transcript; pass 4 kills the job
during image generation and asserts that the resume regenerates only the two
missing stills) and prints the real `ffprobe` output plus the S8 validation
report.

Real manifests from those runs are checked in at
`docs/story-sample-manifest-real-media.json` (every stage real: OpenRouter
story, Gemini images, Chatterbox narration, WhisperX alignment, FFmpeg render —
the primary example), `docs/story-sample-manifest-real-llm.json` (S1–S4 only)
and `docs/story-sample-manifest.json` (complete job with fake LLM/image
providers but real FFmpeg, used by the smoke check), and
`docs/story-pipeline-report.md` records the verification results, the bugs the
tests and the real runs caught, and the known limitations.

## Key Design Decisions

- **ESM only** — `"type": "module"` in package.json, imports use `.js` extensions
- **No `jest.mock()`** — tests inject mocks via `RunnableConfig.configurable` (DI)
- **No `process.env` in agents** — accessed through `src/utils/config.ts` gateway
- **No `instanceof`** — duck-type guards from `src/utils/errors.ts`
- **Zod v4** — `z.record()` requires 2 args (`z.record(z.string(), z.unknown())`)
- **Completeness gate** — ImagePromptGenerator rejects LLM output unless every scene maps to exactly one asset

## Known Limitations

- **Prompts are v1** — few-shot examples, edge cases, and format consistency need iteration
- **No rate limiting** — OpenRouter calls are unbounded; add queue for production
- **Single-threaded** — graph executes nodes sequentially; parallel execution not implemented
- **Artifact cache is opt-in** — enabled via `ARTIFACT_STORE_ENABLED`; without it each invocation re-calls LLMs
- **No error recovery** — a failed node returns error state; no partial retry or fallback

## Roadmap

### Phase 1 — Production Providers

- Provider adapters: GPT Image, Runway, ElevenLabs, PalmierPro
- Orchestration: parallel generation, caching, progress

### Phase 2 — Editorial Quality

- Prompt library with versioned, A/B-tested prompts
- Configurable provider map (env-driven `ASSET_CONFIG`)
- Uniform severity routing (`fatal` / `minor_revision` / `major_revision`) across every QA stage
