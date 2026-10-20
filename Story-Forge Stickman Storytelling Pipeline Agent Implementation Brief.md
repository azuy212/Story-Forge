# Story-Forge: Stickman Storytelling Pipeline: Agent Implementation Brief

## 0. Rules of engagement

1. **Inspect before coding.** Deliver a short Inspection Report (section 2) first. Then implement everything; do not stop at a plan.
2. **Build in milestones** (M1 to M6, section 10). Run that milestone's tests before moving on.
3. **Report only what you ran.** Never claim a test passed or a video rendered unless you executed it. Paste real command output or ffprobe results.
4. **Isolation.** This is a new production mode behind its own entry point. Do not modify, rename, or change defaults of the existing pipeline. Reuse shared infrastructure only through existing abstractions.
5. **Do not assume** module names, paths, env vars, or APIs. Discover them.
6. **Stop and ask** (instead of improvising) if: the transcriber has no word-level timestamps and no segment timestamps; the image provider cannot return a usable image file; FFmpeg lacks libass and subtitles cannot be burned in; or the repo has no structured-output/validation library.

## 1. Goal and non-goals

**Goal:** topic in, finished narrated 16:9 MP4 out: simple child-friendly story, static stickman illustrations with hard cuts, TTS narration, and subtitles timed from real audio. Cheap, reliable, resumable.

**Non-goals:** video clips, Ken Burns/zoom/pan, transitions, background music, upload to YouTube, thumbnails, titles/descriptions, vertical/Shorts output, a new agent framework, database, queue, or dependency (unless the repo already requires one).

## 2. Phase 0: Inspection RepKK?ort (deliver before code)

Find and cite file paths for each item, and note what you will reuse:

- App/orchestrator structure and how a new pipeline or job type is registered (CLI/API/job interface).
- LLM client(s), structured-output support, retry utilities, model config (OpenRouter etc.).
- Image provider: sync or async, size/aspect options, seed or reference-image support, download/persist helpers, rate limits.
- TTS provider: voice/language config, max characters per request, output format, cost per call.
- Transcriber: word-level timestamps available? Reliability? Existing alignment utilities?
- Subtitle utilities (SRT/ASS), burn-in convention, fonts.
- FFmpeg/FFprobe wrappers, media validation, whether libass is present in the installed build.
- Sentence segmenter, if any. Validation library (Zod/Pydantic/etc.), logging, artifact directory and manifest conventions, test framework and mocking patterns.

End the report with **Decision Points**, each with your recommendation and reason:

- **DP1 TTS strategy:** single track vs per-scene chunks (see S6).
- **DP2 Timing source:** measured chunk durations vs transcript alignment (see S7).
- **DP3 Fact grounding:** reuse an existing research capability vs model knowledge with `unverified` flags (see S2).

Then proceed unless a stop condition in section 0 applies.

## 3. Design principle: code owns invariants, the LLM owns creativity

Anything that must be exactly right is computed or verified in code. The LLM never copies text it will later be checked against.

| Concern | Owner |
| --- | --- |
| Story wording, tone | LLM |
| Sentence splitting | Code |
| Which sentences form a scene | LLM proposes sentence IDs, code validates |
| Scene narration text | Code (assembled from sentence IDs, never LLM-copied) |
| Visual content (action, setting, props) | LLM, as structured slots |
| Final image prompt string | Code (template composition) |
| Character appearance | Code (registry injected verbatim) |
| Timing, subtitles, render | Code |

This removes whole bug classes: dropped or duplicated narration, fragments like "In 1753, physicist Georg / Richman was...", prompt typos, stray non-ASCII characters, and character drift.

## 4. Pipeline stages

Stage order: S1 Input, S2 Story, S3 Scenes, S4 Visual plan, S5 Images, S6 Audio, S7 Align and subtitles, S8 Render and validate. Each stage reads and writes artifacts and records status in the manifest. S5 and S6 are independent after S4 and may run in parallel.

### S1: Input and configuration

- Required: `topic`. Optional: `targetDurationSec` (default 150), `language` (default `en`), `tone`, `jobId`/`outputDir`, `style` (default `stickman-history`).
- Extend the existing config system; add only what is needed (section 7). Validate input and fail fast with clear errors (empty topic, non-positive duration, unsupported language).
- Flags: `--stages` / `--resume` / `--from <stage>`, `--dry-run` (stops before any paid call and prints the planned scene count and estimated cost), `--review-story` (pause after S2 for human approval).

### S2: Story

One structured LLM call returns `{ title, story, claims[] }`.

**Writing rules:** simple everyday words; short natural sentences; explain unfamiliar names and objects through context; clear beginning, middle, end; concrete, illustratable actions; open on the central event, problem, mystery, or surprising fact (no generic "Have you ever wondered"); satisfying ending; written for the ear, not the eye.

**Measurable reading-level lint (deterministic, in code):**

- Average sentence length at most 12 words, maximum 22 (configurable).
- Hard-word list (for example *mutiny, uncharted, indigenous, expedition, monarchs, navigator*): allowed only with an in-sentence explanation or replaced with a simpler word.
- Rough syllable-based grade estimate at or below 4 (warning, not a failure).
- Length within ±15% of the word budget: `targetDurationSec × ttsWordsPerMinute / 60` (default 150 wpm, configurable, calibrated from real TTS output where possible).
- On lint failure: one automated rewrite call that includes the exact violations, maximum 2 attempts, then fail with a report. Never ship a story that failed lint silently.

**Factual accuracy (for non-fiction topics):**

- The LLM must also output a `claims` ledger: `{ claim, status: established | disputed | legend | fiction, hedgeInNarration }`.
- Disputed or legendary claims must be hedged in the narration ("People say...", "Some old stories tell...", "Historians are not sure..."), not told as fact. Simplified causal claims must not be overstated (for example "X blocked all trade" when the real picture is more mixed).
- A second, separate verification call checks the story against the ledger and flags unsupported events, invented dialogue/quotes/motives, and unhedged disputed claims. Blocking issues trigger one rewrite.
- If the repo has a research capability, use it to ground claims. Otherwise record `groundingSource: "model-knowledge"` and `unverified: true` per claim in the manifest. Do not claim verification you did not do.
- Fiction topics: invent freely within the requested story, with `status: fiction`.

`--review-story` writes `story.json` and pauses. Without it, "approved" means "passed all validation gates". Use that wording in logs.

### S3: Scene planning (sentence-ID based)

1. **Code** segments the story into sentences with stable IDs (`s1..sN`). The segmenter must handle abbreviations (St., Dr., Mr.), decimals, numbers like 1,492, closing quotes, and ellipses. For non-English languages use the script's terminators (for example Urdu `۔` `؟`).
2. **LLM** receives the numbered sentences and returns `scenes: [{ sceneId, sentenceIds: [..], visualPurpose }]`. It never re-types the narration.
3. **Code validates:** every sentence appears exactly once, in order, contiguous; IDs unique and ordered; no empty scenes.
4. **Code assembles** `narration` by joining the sentences. Narration is therefore exact by construction, and the splitting-names/dates problem cannot occur because sentences are atomic.

Grouping guidance: one visual idea per scene; a scene may hold several sentences if they are one continuous moment; target about 6 to 12 s of estimated speech per scene (`words / wpm`), soft maximum 15 s, minimum about 3 s; consecutive scenes must differ in composition or subject. A single very long sentence is allowed to exceed the soft maximum (sentence integrity wins). If the LLM output fails validation twice, fall back to deterministic greedy grouping by estimated duration and log a warning.

### S4: Visual plan

**4a. Character registry.** One LLM call over the story returns recurring characters: `{ id, name, role, visualDescription }`. Because heads are white and faceless, identity must come from **clothing, headwear, props, colors, and silhouette**. Keep descriptions short and visually distinct from each other. Example: `columbus: "stickman in a long dark-red captain's coat, flat black cap, rolled map under one arm"`.

**4b. Per-scene slots.** One structured LLM call per scene (or batched, whichever is reliable) returns slots only, not a finished prompt:

```json
{
  "sceneId": 5,
  "action": "Columbus kneels and offers a sea chart to the seated king and queen",
  "characters": [
    { "id": "columbus", "pose": "kneeling, one arm extended", "expression": "hopeful eyebrows, small smile" },
    { "id": "ferdinand", "pose": "seated, hands on armrests", "expression": "neutral, one raised eyebrow" }
  ],
  "setting": "Spanish royal hall with stone arches and tapestries",
  "props": ["rolled sea chart with abstract line markings", "two ornate thrones"],
  "lighting": "warm light from tall windows",
  "composition": "wide side view, characters in the midground"
}
```

The slots must illustrate the actual narration. Props are literal visual evidence. Metaphors are allowed only for abstract scenes and must be marked. Hedged claims (legends) should be drawn as the story or rumor being told, not as verified events, where practical.

**4c. Code composes the final prompt** from the template in section 6, injecting registry descriptions verbatim for every character present. Characters appear only in scenes where they belong. The composed `imagePrompt` is stored in the scene, and a lint step runs (section 6).

Accuracy: era-appropriate clothing, objects, architecture. Respectful depiction of real peoples and groups (same stickman style, dignified poses, no caricature). Violence or suffering is shown at a mild, non-graphic level. If the narration contains a significant element (for example captives being taken), the image must not contradict it or ignore it in a misleading way. Flag it in `visualPurpose` and handle it tastefully.

### S5: Images

- One image per scene via the existing provider. Output `images/scene-%03d.<ext>`. Deterministic scene-to-file mapping, with the mapping and generation metadata (provider, model, seed if any, prompt hash, attempts) in the manifest.
- Aspect ratio 16:9 (or the closest the provider supports, then cover-crop in render, never stretch).
- Validate each file: decodes successfully, minimum resolution (at least 1280×720), non-blank (pixel variance above threshold), not byte-identical to another scene's image.
- Concurrency default 3, configurable. Use existing retry utilities for timeouts, 429s, malformed responses, and failed downloads.
- If a provider refuses a prompt, allow **one** logged prompt-softening retry for that same scene (record both prompts). Never substitute another scene's image. A scene that finally fails is recorded as `failed` with the reason, and the job stops at that stage and is resumable for only the failed scenes.
- Optional QA (off by default): flag images where text appears (OCR or a vision-model check) and regenerate once.

### S6: Narration audio (DP1)

Use the existing TTS provider, voice, and language.

- **Default recommendation: per-scene chunks**, if the TTS has request-length limits, if prosody is acceptable across chunk boundaries, or if per-scene regeneration is valuable. Each chunk is one scene's narration. Measure each chunk's true duration with ffprobe, then concatenate with a configurable small gap (default 150 to 250 ms, equal to the scene padding) using FFmpeg's concat with re-encode to a uniform format.
- **Alternative: one full track** if the provider handles the full length reliably and sounds noticeably better. In that case timing comes from S7 alignment.
- Either way: validate every audio file (non-empty, decodable, plausible duration vs word count within about 0.5× to 2× of expected), preserve order, no duplicated or truncated sentences, store chunk boundaries and offsets in the manifest. Choose and justify in the Inspection Report.

### S7: Alignment, scene timing, subtitles

Times come from the audio, not from guessed word counts.

- **If chunked TTS (DP2 recommended):** scene start/end come from measured chunk durations plus known gaps. They are exact. Run the transcriber on the final track only to get word timings for subtitles and as a QA cross-check.
- **If a single track:** transcribe with word timestamps, then align.

**Alignment algorithm (single-track or subtitle word timing):**

1. Tokenize the *script* (known text) and the *ASR output*: lowercase, strip punctuation, strip diacritics (María/Maria), expand or normalize numerals both ways ("1492" vs "fourteen ninety-two"), normalize hyphens and apostrophes.
2. Run a monotonic sequence alignment (for example `difflib.SequenceMatcher` or Needleman–Wunsch) between script tokens and ASR tokens. Matched tokens inherit ASR timestamps. Unmatched script tokens get timestamps interpolated between their matched neighbors.
3. **Subtitle text always comes from the script**, not from raw ASR, so wording and punctuation are correct. Timing comes from the audio.
4. Scene start = start of its first script word, scene end = end of its last. Make scenes contiguous: boundary between scene *i* and *i+1* is the start of *i+1* (or the midpoint of the silence gap, pick one and document it). First scene starts at 0.0. Last scene ends at the audio end (plus small tail padding). No gaps, overlaps, or non-positive durations.
5. **Quality gate:** per-scene match ratio at or above 0.9 is OK. Below that, log a warning and use the defined fallback (proportional interpolation by word count within the neighbors' known bounds). If overall match ratio is below 0.75, fail the stage rather than render a badly desynced video.
6. Snap all boundaries to the video frame grid (section S8) so cumulative rounding cannot drift.

**Subtitles:** generate ASS (preferred, for styling control) plus an SRT copy. Phrases split at punctuation or natural clause breaks. At most 2 lines, about 42 characters per line (configurable), minimum on-screen time about 0.8 s, no overlap, never carry text from the wrong scene. Check font glyph coverage for non-Latin languages and use an RTL-capable setup for Urdu/Arabic.

### S8: Render and validate

- Use the existing FFmpeg wrapper; build arguments as an **array** (no shell strings); escape the subtitle filter path correctly (or run with the working directory set and use relative paths).
- Per scene: hold the image for `[start, end)`; hard cuts only; no zoompan, no fades.
- Normalize every image: scale to cover then crop (or scale-and-pad with a matching background) to 1920×1080, `setsar=1`, constant frame rate (default 30 fps), `yuv420p`.
- Avoid the concat-demuxer last-image bug (repeat the last entry or use an explicit end), and keep scene boundaries on frame boundaries.
- Encode H.264 (`libx264`, CRF about 18 to 20, preset `medium`), AAC 48 kHz (about 192 kbps), `-movflags +faststart`. Burn in ASS subtitles by default and keep the sidecar `.srt`.
- Write to a temp file, validate, then atomically rename to `final.mp4`.

**Validation (a job is `complete` only if all pass):**

- FFmpeg exit code 0 and output file exists with size above 0.
- ffprobe: one video stream (h264, yuv420p, 1920×1080, expected fps) and one audio stream (aac).
- Video duration within one frame or about 100 ms of audio duration. Narration not truncated: the final audio duration matches the S6 output within tolerance.
- `blackdetect` finds no black frames beyond a tiny threshold at the start and end.
- `silencedetect` finds no unintended silence longer than about 1.0 s (the intended inter-scene gap is excluded).
- Extract and inspect (or programmatically compare) one frame near the middle of 3 scenes: the right image is shown and subtitles are visible.

## 5. Data contracts

Use the repo's validation library and naming conventions (the examples use camelCase).

**LLM-facing:** `StoryOutput { title, story, claims[] }`, `SceneGrouping { scenes[{ sceneId, sentenceIds[], visualPurpose }] }`, `CharacterRegistry`, `SceneVisualSlots` (as in S4b).

**Internal `Scene`** (generated metadata is never requested from the LLM):

```json
{
  "sceneId": 5,
  "sentenceIds": ["s5"],
  "narration": "Desperate for money, Columbus turned to the Spanish monarchs, King Ferdinand II and Queen Isabella I.",
  "visualPurpose": "Columbus asks the royal couple for funding",
  "slots": { },
  "imagePrompt": "…composed from template…",
  "imagePath": "images/scene-005.png",
  "audio": { "chunkPath": "audio/scene-005.mp3", "durationSec": 7.42 },
  "timing": { "start": 31.20, "end": 38.62, "method": "measured" },
  "status": { "image": "done", "audio": "done" }
}
```

**Validate programmatically:** story non-empty; at least one scene; IDs unique and ordered; narration and prompt non-empty; **concatenated scene narration equals the story's sentences in order**; all images and audio exist before render; timings contiguous and covering `[0, audioDuration]`; final MP4 passes validation.

**Artifact layout:**

```
jobs/<jobId>/
  manifest.json
  story.json  claims.json  characters.json  scenes.json
  images/scene-001.png …
  audio/chunks/…  narration.mp3
  transcript.json  subtitles.ass  subtitles.srt
  render/…  final.mp4
```

**Manifest** records: topic and config, stage statuses with timestamps and errors, input fingerprints (section 8), the story, claims and `unverified` flags, scenes with prompts, image paths and metadata, audio paths and offsets, transcript path, subtitle paths, scene timings and methods, warnings, final video path, and ffprobe summary.

## 6. Image prompt template and lint

Stored as a **style profile file** (not hardcoded), so styles can be added later. Do not reference a third-party app or brand by name. Describe the style instead.

```
A hand-drawn digital illustration, clean vector line art, heavy black outlines,
cel-shaded coloring, desaturated muted color palette.

Scene: {action}

Characters: {characters: registry description + pose + expression, one per line}

Setting: {setting}

Key props: {props}

Lighting: {lighting}. Composition: {composition}.

Style constraints: simple white round stickman heads with black line-art bodies,
no facial features except simple expressive eyebrows and mouths, richly detailed
environment with strong perspective and clean black line art, desaturated colors,
no photographic textures, no UI, no text, no lettering, no numbers, no captions,
no watermarks. Maps, books, flags, and documents show only abstract marks and
symbols, never readable writing.
```

Notes: "architectural background" became "richly detailed environment" so beach, ocean, and forest scenes are not forced to include buildings. The old "props and foreground metaphors" slot is now "Key props", literal visual evidence, because the story rules require illustrating the actual event.

**Prompt lint (code, before any image call):** ASCII/Latin-only check (reject stray CJK or other unexpected characters), no repeated adjacent words ("background background", "dramatic dramatic"), no unfilled `{placeholders}` or `[BRACKETS]`, all required slots non-empty, registered characters only, no request for readable text, length under the provider limit.

## 7. Configuration

Reuse existing provider env vars. Add only what is needed, with defaults, and document in the README or `.env.example`:

`STORY_LLM_MODEL`, `STORY_TARGET_DURATION_SEC` (150), `STORY_LANGUAGE` (en), `STORY_TTS_WPM` (150), `STORY_IMAGE_CONCURRENCY` (3), `STORY_SCENE_TARGET_SEC` (6 to 12 range), `STORY_RESOLUTION` (1920x1080), `STORY_FPS` (30), `STORY_SCENE_GAP_MS` (200), subtitle style overrides. No secrets in source control.

## 8. Reliability and resume

- Each stage stores an **input fingerprint** (hash of its inputs and relevant config). On resume, a stage reruns only if its output is missing, invalid, or its fingerprint changed. Changing a scene's prompt invalidates only that scene's image. Changing render settings re-renders only.
- Per-scene image and audio artifacts are individually resumable.
- Atomic writes (temp file then rename) for manifest and artifacts. Never mark `complete` before S8 validation passes. A crash mid-stage leaves the stage `running`, which is treated as incomplete on resume.
- Use the existing retry utilities with backoff for transient provider errors. Non-transient errors (validation, refusal) fail fast with actionable messages.
- Log per stage: duration, retries, cost estimate if available.

## 9. Testing and acceptance

Use the repo's test framework. Mock all providers for unit tests (no paid calls). Use the 19-scene Columbus sample as a golden fixture.

| # | Test |
| --- | --- |
| 1 | Input validation (empty topic, bad duration, bad language) |
| 2 | Schema validation for story, claims, scenes, slots |
| 3 | Segmenter: abbreviations, numbers, quotes, ellipses, Urdu terminators |
| 4 | Grouping validation: gaps, duplicates, reordering, empty scenes all rejected; fallback grouping works |
| 5 | Property test: concatenated scene narration always equals the story (random groupings) |
| 6 | Reading-level lint: passes simple text, fails on hard words and long sentences |
| 7 | Prompt composition and lint: registry injected verbatim; rejects stray CJK, duplicated words, unfilled placeholders |
| 8 | Image-to-scene mapping and image validation (corrupt, blank, duplicate) |
| 9 | TTS validation (empty, truncated, wrong duration) |
| 10 | Alignment: numerals, diacritics, punctuation, ASR dropped/extra words, repeated phrases, quality-gate behavior |
| 11 | Scene timing: contiguous, positive, first at 0, last at audio end, frame-snapped |
| 12 | Subtitles: line length, min duration, no overlap, script text used |
| 13 | FFmpeg argument construction (no shell strings, path escaping with spaces/quotes) and failure handling |
| 14 | Manifest generation |
| 15 | Resume: fail at S5/S8 and verify earlier artifacts reused; fingerprint invalidation |

**End-to-end smoke test:** run a real small job (about 45 to 60 s, 4 to 6 scenes) if provider credentials are available. Verify the final MP4 with ffprobe, blackdetect, silencedetect, and sampled frames. If credentials are unavailable, run the full pipeline with fake providers that produce real small images and real audio so FFmpeg and ffprobe are still exercised, and state clearly that the real-provider smoke test was not run.

## 10. Milestones

- **M1:** Inspection Report, config, input validation, manifest and stage runner with resume and fingerprints.
- **M2:** S2 story with lint and claim ledger. S3 segmenter and grouping.
- **M3:** S4 character registry, slots, template composition, prompt lint.
- **M4:** S5 images and S6 audio.
- **M5:** S7 alignment, timing, subtitles.
- **M6:** S8 render and validation, end-to-end smoke test, docs.

## 11. Deliverables and final report

1. Working pipeline with documented run command (for example `<cmd> story-video --topic "…" --duration 150`).
2. Source, schemas, style profile file, tests.
3. README section: usage, flags, config, artifact layout, resume behavior.
4. A real sample `manifest.json`.
5. Final report containing: files created or changed, test commands and actual results, ffprobe output of the smoke-test MP4, and known limitations and provider-specific assumptions (including anything not verified).

## 12. Definition of done

Given a topic, one command produces a validated MP4 with: complete, correctly ordered narration; simple, accurate, appropriately hedged story; consistent stickman illustrations matching each scene; no sentence fragments from splitting; subtitles synced to audio; hard cuts only; no black frames or unintended silence; and an unchanged existing pipeline.
