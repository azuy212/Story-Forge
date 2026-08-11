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
SubtitleGenerator    — provider: WhisperX word-level alignment of the narration WAV → SRT/ASS (stub fallback)
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
Publisher            — provider: upload to YouTube (and other platforms) with metadata + thumbnail
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

| Field | Required | Type | Example | Notes |
|---|---|---|---|---|
| `project.pillar` | yes | string | `"Geography"` | High-level category |
| `project.topic` | yes | string | `"Unrecognized Countries"` | Specific angle |
| `branding.channel` | no | string | `"Universe Decoded by Zain"` | Channel name |
| `branding.handle` | no | string | `"@UniverseDecodedByZain"` | Channel handle |
| `branding.creator` | no | string | `"Ali Zain"` | Creator name |
| `branding.cta` | no | string | `"Follow for more mysteries of the universe."` | Deterministic CTA configuration |
| `branding.enabled` | no | boolean | `true` | Enable canonical outro |
| `branding.outroAsset` | no | string | `"assets/branding/outro.mp4"` | Relative repository asset path |
| `branding.ctaEnabled` | no | boolean | `true` | Render CTA when outro lacks one |
| `branding.style` | no | string | `"Documentary"` | Visual style guide |
| `branding.colorPalette` | no | string | `"Cold blue"` | Color theme |
| `branding.logo` | no | string | `"UD logo"` | Logo reference |
| `branding.voice` | no | string | `"en-US-Neural2-F"` | TTS voice |
| `branding.platforms` | no | string[] | `["youtube"]` | Target publish platforms |
| `execution.version` | yes | string | `"0.1.0"` | Pipeline version |

`branding/brand.json` owns default branding values. Relative media paths are
resolved centrally by walking from process working directory toward repository
root; commands must run from orchestrator package or workspace root.

### Implemented

| Component | Type | Status |
|---|---|---|
| ResearchAgent | LLM agent | complete |
| ResearchQA | LLM gate | complete |
| StoryPlanner | LLM agent | complete |
| ScriptWriter | LLM agent | complete |
| ScriptQA | LLM gate | complete |
| VisualDirector | LLM agent | complete |
| ImagePromptGenerator | LLM agent | complete |
| PromptQA | LLM gate | complete |
| AssetGenerator | provider | complete |
| NarrationGenerator (TTS) | provider | complete |
| SubtitleGenerator | provider | complete |
| VideoComposer | provider | complete |
| ReleaseValidation | deterministic gate | complete |
| ReleaseReview | LLM gate | complete |
| MetadataGenerator | LLM agent | complete |
| ThumbnailGenerator | LLM + provider | complete |
| Publisher | provider | complete |
| `runAgent()` harness | shared | complete |
| Prompt cache (in-memory) | utility | complete |
| Shared editorial guidelines | prompt infra | complete |
| Completeness validation | ImagePromptGenerator | complete |
| Gemini instruction filter | PromptQA | complete |
| `singleAttempt` option | runAgent | complete |
| Telemetry (model, tokens, retries, versions) | per-node | complete |
| Zod schema validation | all outputs | complete |
| Dependency injection for tests | all agents | complete |
| Provider interface + stub pattern | all providers | complete |
| FFprobe media validation | ReleaseValidation | complete |
| SRT parsing (monotonic, overlap, bounds) | ReleaseValidation | complete |
| Unit tests | 221 | passing |
| Integration test | 8 | passing |

### Not Implemented

| Component | Notes |
|---|---|
| Provider adapters (production) | GPT Image, Runway, ElevenLabs, PalmierPro need credentials |
| Orchestration layer | Parallel execution, caching, progress tracking |
| Configurable provider map | `ASSET_CONFIG` hardcoded in asset-generator |
| ResearchCollector agent | Enum entry, no node |
| PromptEngineer agent | Enum entry, no node |
| NarrationPlanner agent | Enum entry, no node |
| QAReviewer agent | Enum entry, no node |

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

### Transcriber Subtitle Alignment

Subtitle timing comes from the actual narration WAV, not word counts or LLM
duration estimates. The SubtitleGenerator sends the TTS-generated
`narration.wav` to a separately-run transcriber service and builds
SRT/ASS cues from the returned word timestamps (3–5 words per cue, preferring
punctuation/timing-gap boundaries).

```text
NarrationGenerator (TTS)
   ↓ narration.wav
Transcriber service :8030
   ↓ word timestamps
Transcriber-backed SubtitleProvider → SRT / ASS
   ↓
VideoComposer
```

The service runs outside the LangGraph process:

```bash
# Local development
TRANSCRIBER_URL=http://localhost:8030
```

HTTP contract (`POST {TRANSCRIBER_URL}/align`, multipart/form-data):

- `file` — the actual narration WAV (required)
- `text` — known transcript hint (optional, improves alignment)

Response JSON:

```json
{ "segments": [{ "start": 0.0, "end": 10.2, "text": "...",
    "words": [{ "word": "In", "start": 0.17, "end": 0.25 }] }] }
```

If alignment fails in real-provider mode the orchestrator fails closed at
SubtitleGenerator rather than silently producing mis-timed subtitles. When
`USE_REAL_PROVIDERS=false` the stub provider keeps a heuristic fallback for
tests/development.

### Run Tests

```bash
# Unit tests (221 tests, no API key needed — uses DI mocks)
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
  Reads:  content.narration
  Writes: audio.{narrationUrl, narrationDurationMs, voice, generatedAt}

Step 11 — SubtitleGenerator (provider)
  Reads:  audio.narrationUrl, content.narration
  Writes: subtitles.{srt, ass, wordTimestamps, generatedAt}

Step 12 — VideoComposer (provider)
  Reads:  production.scenes[].{assetUrl, startSecond, endSecond, durationSeconds},
          audio.narrationUrl, subtitles.srt, content.estimatedDurationSeconds, branding
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

| Field | Format | Source |
|---|---|---|
| `promptId` | `prompt-scene-NNN` | ImagePromptGenerator |
| `assetId` | `asset-scene-NNN` | AssetGenerator (deterministic fold) |
| `filename` | `scene-NNN.png` / `scene-NNN.mp4` | AssetGenerator (deterministic fold) |

### Providers

| Asset Type | Default Provider | Extension |
|---|---|---|
| image | gpt-image | png |
| video | runway | mp4 |

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
    narration-generator.node.ts      — TTS synthesis provider
    subtitle-generator.node.ts       — WhisperX subtitle alignment provider
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
    subtitle-provider.ts             — SubtitleProvider interface
    stub-subtitle-provider.ts        — stub for tests
    whisperx-provider.ts             — WhisperX HTTP client (:8030 /align)
    whisperx-subtitle-provider.ts    — WhisperX-backed SubtitleProvider (real)
    asset-provider.ts                — AssetProvider interface
    stub-asset-provider.ts           — stub for tests
    tts-provider.ts                  — TTS provider interface
    stub-tts-provider.ts             — stub for tests
    publisher-provider.ts            — PublisherProvider interface
    stub-publisher-provider.ts       — stub for tests
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
  comfyui-asset-provider.test.ts
```

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
