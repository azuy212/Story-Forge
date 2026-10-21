# Story-Forge Stickman Storytelling Pipeline — Final Report

Topic in → validated 1080p MP4 out (stickman illustrations, per-scene narration,
audio-timed subtitles), one command, resumable, with the existing Shorts
pipeline untouched.

- Run command: `pnpm --filter youtube-shorts-orchestrator story "The long night at sea" --duration 150`
  (after `pnpm --filter youtube-shorts-orchestrator build`)
- README: `apps/orchestrator/README.md` → "Story-Forge Stickman Storytelling Pipeline"
- Sample manifests:
  - `docs/story-sample-manifest.json` — complete S1–S8 job (fake agents/providers,
    real FFmpeg/ffprobe, synthetic images and audio)
  - `docs/story-sample-manifest-real-llm.json` — **real OpenRouter run of S1–S4**
    (see §6; the media stages could not run in this environment)

Everything below is output from commands that were actually run, in this
checkout, on 2026-10-20.

---

## 1. Files created

New story module (all new code lives here — nothing in `src/graph/**` or any
agent node was touched):

```
apps/orchestrator/src/story/          (6966 lines, 23 files)
  index.ts          public entry point (re-exports only)
  run.ts            S1–S8 orchestrator, resume, review gate
  runner.ts         stage runner (fingerprint + atomic resume)
  agents.ts         five story LLM calls behind one injectable interface
  config.ts         STORY_* / CLI resolution + the CLI override contract
  input.ts          input validation + deterministic job id
  paths.ts          jobs/<jobId>/ layout (anchored to the package root)
  manifest.ts       fingerprinted stages, resume lifecycle, warnings
  resume.ts         frozen-config resume: stored config wins, changed flags fail
  atomic.ts         atomic JSON/text writes
  types.ts          Zod schemas + data contracts
  sentences.ts      script-aware sentence segmentation + grouping rules
  style-profile.ts  image style profile loader
  prompt.ts         prompt composition (registry verbatim) + prompt lint
  lint.ts           reading-level lint + hard-word gate + ±15% word budget
  alignment.ts      script↔ASR tokenizer, LCS, numeric spans, proportional fallback
  subtitles.ts      sentence-aware cue building → ASS + SRT
  timing.ts         measured, frame-snapped scene timeline
  images.ts         per-scene image stage + DP4 gates + duplicate detection
  audio.ts          per-scene TTS chunks, master concat, voice-drift outliers
  media.ts          ffprobe/ffmpeg measurement helpers (one probe for all fields)
  ffmpeg-args.ts    FFmpeg argument construction (pure, array-form)
  render.ts         single-pass render + deterministic output validation
```

Prompts, style profile and subtitle fonts:

```
apps/orchestrator/prompts/story-story/v1.md
apps/orchestrator/prompts/story-verify/v1.md
apps/orchestrator/prompts/story-scenes/v1.md
apps/orchestrator/prompts/story-characters/v1.md
apps/orchestrator/prompts/story-slots/v1.md
apps/orchestrator/prompts/story/style/stickman-history.json
apps/orchestrator/assets/branding/NotoSans-Bold.ttf
apps/orchestrator/assets/branding/NotoNaskhArabic-Bold.ttf
apps/orchestrator/assets/branding/LICENSE-OFL-1.1.txt
```

Entry points and docs:

```
apps/orchestrator/scripts/story-video.mjs     commander CLI (loads .env, imports dist/story/index.js)
apps/orchestrator/scripts/story-smoke.mjs     4-pass end-to-end smoke test
apps/orchestrator/docs/story-sample-manifest.json          (smoke job, fake LLM/images, real FFmpeg)
apps/orchestrator/docs/story-sample-manifest-real-llm.json  (real OpenRouter S1–S4)
apps/orchestrator/docs/story-sample-manifest-real-media.json (real S1–S4 + real S6–S8)
apps/orchestrator/docs/story-pipeline-report.md (this file)
```

Tests — 17 suites, 237 tests, all new except the two cases appended to the
existing Chatterbox suite:

```
apps/orchestrator/tests/story-sentences.test.ts       25   (incl. randomised grouping properties)
apps/orchestrator/tests/story-alignment.test.ts       15
apps/orchestrator/tests/story-subtitles.test.ts       13
apps/orchestrator/tests/story-timing.test.ts          10
apps/orchestrator/tests/story-lint.test.ts            17   (incl. up-front style limits)
apps/orchestrator/tests/story-prompt.test.ts          30   (incl. two real-run regressions)
apps/orchestrator/tests/story-columbus-golden.test.ts  5   (19-scene real fixture)
apps/orchestrator/tests/story-ffmpeg-args.test.ts     13
apps/orchestrator/tests/story-render.test.ts          10   (frame margin, severity, real FFmpeg failure, black threshold)
apps/orchestrator/tests/story-manifest.test.ts        12
apps/orchestrator/tests/story-resume.test.ts           9   (stored config wins; changed flags refused; zero calls)
apps/orchestrator/tests/story-config.test.ts          19   (incl. bundled fonts)
apps/orchestrator/tests/story-prompts.test.ts          8
apps/orchestrator/tests/story-shared-edits.test.ts    15
apps/orchestrator/tests/story-schemas.test.ts         19
apps/orchestrator/tests/story-images.test.ts          10
apps/orchestrator/tests/story-audio.test.ts           12
apps/orchestrator/tests/story-cli.test.ts              4
apps/orchestrator/tests/fixtures/story-columbus-19.json
```

## 2. Files changed (additive / behaviour-preserving)

| File                                         | Change                                                                | Why it cannot affect the Shorts pipeline                                                             |
| -------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/utils/config.ts`                        | `+76` — a `STORY_*` accessor block                                    | New keys only; no existing accessor body changed                                                     |
| `src/models/agent-model.ts`                  | `+8` — five story members                                             | String-enum members appended                                                                         |
| `src/models/model-factory.ts`                | `+18` — story roles in `AGENT_ROLES` + `STORY_LLM_MODEL` fallback     | The fallback term is `undefined` for non-story agents, so the resolution chain is unchanged for them |
| `src/models/prompt-paths.ts`                 | `+7` — five `story-*` keys                                            | Existing 13 keys and values byte-identical                                                           |
| `src/utils/node-labels.ts`                   | `+5` — labels for the story agents                                    | Lookup table additions                                                                               |
| `src/utils/script-complexity.ts`             | `+22/-11` — optional `thresholds` parameter                           | The default parameter is the historical constant object                                              |
| `src/providers/composer/ffmpeg/normalize.ts` | `+19/-1` — optional `fit`/`scaleFlags` on `staticScaleFilter`         | Confined to a new `fit === "cover"` branch; the default path returns a byte-identical string         |
| `src/providers/tts-provider.ts`              | `+7` — optional `skipWpmNormalization`                                | Optional field                                                                                       |
| `src/providers/chatterbox-tts-provider.ts`   | `+3/-1` — `opts.skipWpmNormalization \|\|` added to the WPM condition | Without the flag the condition is exactly `videoProfile === "long" ? undefined : …`, i.e. unchanged  |
| `.gitignore`                                 | `+4` — anchored `/apps/orchestrator/jobs/`                            | Anchored, so another `jobs` directory elsewhere is not ignored                                       |
| `apps/orchestrator/package.json`             | `+2/-1` — `"story": "node scripts/story-video.mjs"`                   | New script                                                                                           |
| `apps/orchestrator/README.md`                | story section + fonts + exit codes + smoke description                | Docs                                                                                                 |
| `tests/chatterbox-tts-provider.test.ts`      | `+62` — 2 regression cases for `skipWpmNormalization`                 | Additive cases                                                                                       |

Two repo-level fixes outside that list, both required to make the gates run as
documented:

| File                                                                                   | Change                                               | Why                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/orchestrator/package.json`, `apps/image-provider/package.json`, `pnpm-lock.yaml` | `+ devDependency oxlint-tsgolint@^7.0.2001`          | `--type-aware` fails on a clean checkout with "Failed to find tsgolint executable… add the `oxlint-tsgolint` package". pnpm only links bins for direct dependencies, so the lint gate could not run at all (§4.2). |
| `apps/orchestrator/scripts/story-video.mjs`                                            | loads `.env` + IPv4 network runtime, dynamic import  | Nothing under `src/` reads `.env`, so the documented `OPENROUTER_API_KEY` was invisible to the one-command entry point; the first real run died with "OPENROUTER_API_KEY not set".                                 |
| `apps/orchestrator/tests/setup-env.ts`                                                 | `+5` — pins `NARRATION_TARGET_WPM=140`               | Four pre-existing tests assert values derived from the narration pace and only passed when a local `.env` happened to exist; CI never creates one, so `pnpm test` was red on a clean checkout (§4.2).              |
| `.github/workflows/unit-tests.yml`                                                     | `+6` — setup-python + `pip install ruff` before lint | The unit-tests job runs `pnpm lint`, which shells out to Ruff, but installed none; `--type-aware` also could not start without `oxlint-tsgolint`. Both gates would have exited 1 before linting a file.            |

No `jest.mock()` was introduced anywhere. The story tests inject
`StoryAgents`, `AssetProvider`, `TTSProvider` and the transcriber through
`runStoryJob` options, and the two shared-edit regressions that need module
substitution reuse the pre-existing `jest.unstable_mockModule` pattern in the
Chatterbox suite.

## 3. Test matrix → tests (brief §9)

The brief's 15 areas, mapped to the suites that now cover them:

| #   | Area                                                                  | Covered by                                                                                                                                                                                     | Verdict |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Input validation (empty topic, bad duration, bad language)            | `story-config.test.ts` (validation + `assertStoryInput`)                                                                                                                                       | covered |
| 2   | Schema validation: story, claims, scenes, slots                       | `story-schemas.test.ts` (19 cases: missing fields, bad enums, blank slots, ids)                                                                                                                | covered |
| 3   | Segmenter: abbreviations, numbers, quotes, ellipses, Urdu             | `story-sentences.test.ts` (abbreviations, initials, decimals, quotes, `…`, `۔؟۔` `।`, `。！？`)                                                                                                | covered |
| 4   | Grouping: gaps, duplicates, reordering, empty scenes, fallback        | `story-sentences.test.ts` — explicit cases + randomised corruptions; `fallbackGrouping` property test                                                                                          | covered |
| 5   | Property: concatenated narration always equals the story              | `story-sentences.test.ts` — 300 random partitions across 3 seeds, plus exact reassembly                                                                                                        | covered |
| 6   | Reading-level lint: simple passes, hard words/long sentences fail     | `story-lint.test.ts` (hard-word exemption requires an in-sentence explanation)                                                                                                                 | covered |
| 7   | Prompt composition + lint: registry verbatim, stray CJK, dup words    | `story-prompt.test.ts`, `story-prompts.test.ts`, **`story-columbus-golden.test.ts`** (real 19-scene fixture)                                                                                   | covered |
| 8   | Image-to-scene mapping + validation (corrupt, blank, duplicate)       | `story-images.test.ts` (real lavfi fixtures through the production ffprobe path; duplicate + reuse)                                                                                            | covered |
| 9   | TTS validation (empty, truncated, wrong duration)                     | `story-audio.test.ts` (real WAVs; zero-duration, undecodable, implausible band, >450-char split)                                                                                               | covered |
| 10  | Alignment: numerals, diacritics, punctuation, ASR noise, gate         | `story-alignment.test.ts` (decimal, year, diacritics, dropped/extra words, proportional fallback)                                                                                              | covered |
| 11  | Scene timing: contiguous, positive, first at 0, ends at audio         | `story-timing.test.ts`                                                                                                                                                                         | covered |
| 12  | Subtitles: line length, min duration, no overlap, script text         | `story-subtitles.test.ts`                                                                                                                                                                      | covered |
| 13  | FFmpeg argument construction + failure handling                       | `story-ffmpeg-args.test.ts` (array form, quoting, one-pass filter graph); **`story-render.test.ts`** (real FFmpeg failure in a job path with spaces and a quote)                               | covered |
| 14  | Manifest: stages, fingerprints, warnings, artifacts                   | `story-manifest.test.ts`                                                                                                                                                                       | covered |
| 15  | Resume: fail mid-stage → earlier artifacts reused; invalidation       | `story-manifest.test.ts`; `story-images.test.ts` / `story-audio.test.ts` (per-scene reuse + prompt change); **smoke pass 4** (kill during S5, resume, only 2 of 4 regenerated)                 | covered |
| 16  | Resume: config is frozen — a changed flag fails instead of re-running | `story-resume.test.ts` (stored duration wins on a dry run; `--duration` conflict throws `STORY_CONFIG_CONFLICT` with zero agent calls and an untouched manifest; execution-only flags allowed) | covered |

Remaining honest gaps in the matrix:

- **Nothing in the matrix is now unmapped.** Areas 8 and 9 are still _tested_
  with locally generated media so the suite runs offline, but §6.5 runs both
  against the real providers (six Gemini images, six Chatterbox chunks).
- The 19-scene golden fixture is a **reconstruction** of the original real
  visual plan: the original JSON was never in this repository. It reproduces
  the three documented failures (stray CJK in scene 3, the `StyleConstraints`
  field-name leak in scene 13, and the unexplained hard words _mutiny_,
  _Genoese_, _uncharted_) and runs through the production style profile and
  linters, so a regression in either one fails the suite.

## 4. Verification evidence

### 4.1 Unit tests

```
$ pnpm --filter youtube-shorts-orchestrator exec node --experimental-vm-modules \
    node_modules/jest/bin/jest.js

Test Suites: 94 passed, 94 total
Tests:       1347 passed, 1347 total
Time:        15.976 s
```

Story suites only:

```
Test Suites: 17 passed, 17 total
Tests:       237 passed, 237 total
```

### 4.2 Type check, lint, format, build, conventions

```
$ pnpm --filter youtube-shorts-orchestrator typecheck     # tsc --noEmit
(no output — clean)

$ pnpm lint                                               # full root gate
youtube-shorts-orchestrator lint                 → clean (no output)
youtube-shorts-orchestrator lint:langgraph-json  → All paths in langgraph.json are valid…
gemini-image-automation lint                     → clean (no output)
ai-series-monorepo lint:python                   → All checks passed! (tts, transcriber)
check:conventions                                → conventions: all orchestrator conventions hold
check:graph-docs                                 → graph-docs: AGENTS.md pipeline matches src/graph/index.ts

$ pnpm format:check
orchestrator → All matched files use Prettier code style!
image-provider → All matched files use Prettier code style!

$ pnpm build
tsc && node scripts/copy-mjs.mjs → copied 3 .mjs file(s) to dist/
gemini-image-automation build → tsc (clean)
admin-ui build → vite build → ✓ built in 2.91s
```

Two environment notes, both resolved without touching production code:

- **`oxlint --type-aware` could not start on a clean checkout.** `oxlint-tsgolint`
  was in the pnpm store but pnpm never links the `tsgolint` bin for a transitive
  dependency, so oxlint exited 1 with "Failed to find tsgolint executable"
  before reading any file. Adding `oxlint-tsgolint@^7.0.2001` as a
  devDependency of both linted packages links the bin; the lint above ran with
  **no local symlink hack** (`node_modules/.bin/tsgolint` is now a pnpm-linked
  shim).
- **A clean checkout had 4 failing tests, unrelated to this work.** CI never
  creates `apps/orchestrator/.env`, and four suites (`chatterbox-tts-provider`
  ×2, `visual-director`, `video-profile-long`) asserted values derived from
  `NARRATION_TARGET_WPM`. With the file absent the pace fell back to 160 wpm and
  they failed. `tests/setup-env.ts` now pins 140 wpm (the value `.env.example`
  documents), so the suite is reproducible on a clean checkout. Verified with
  `.env` moved aside: `Test Suites: 92 passed, Tests: 1331 passed`; restored:
  the same.
- **The CI lint job could not have run either.** `.github/workflows/unit-tests.yml`
  runs `pnpm lint`, which ends in `scripts/lint-python.sh`; that job installed no
  Ruff, and `oxlint --type-aware` had no `tsgolint` bin. The workflow now sets up
  Python 3.11 and installs Ruff before linting, and the devDependency change
  above provides `tsgolint`. I cannot execute GitHub Actions here, but the same
  commands run clean locally (with a standalone Ruff on `PATH`).
- **Python lint needs Ruff.** `apps/tts/venv` and `apps/transcriber/venv` do not
  exist in this environment (`python3 -m venv` has no `ensurepip` here). Ruff was
  installed standalone and put on `PATH`; `scripts/lint-python.sh` finds it and
  both services pass. No Python file was modified by this task. `pnpm run setup:all`
  restores the venvs for a normal checkout.

### 4.3 End-to-end smoke — 4 passes, 26/26 checks

```
$ rm -rf /tmp/opencode/story-smoke && node scripts/story-smoke.mjs
exit=0

pass 1 — full job
  ok   job reports complete
  ok   final.mp4 exists
  ok   every stage is done
  ok   render validations all passed
  ok   four scenes, one image and one chunk each
  ok   narration was rebuilt from sentence ids, not model text
  ok   scene image gate recorded real source dimensions
  ok   subtitles: cues exist, never overlap, respect the minimum duration
  ok   subtitle text comes from the script
  ok   timeline is contiguous and covers the audio
  ok   alignment matched every scene
  ok   no voice outliers were flagged
  ok   manifest records the unverified grounding source

pass 2 — resume with nothing changed
  ok   second run is complete too
  ok   no agent or provider was called again
  ok   every stage fingerprint is unchanged and reused

pass 3 — force S5/S6/S7 and prove per-scene artifact reuse
  ok   forced rerun still reports complete
  ok   the forced stages actually re-ran
  ok   every image was reused, not regenerated
  ok   every narration chunk was reused, not re-synthesized
  ok   every transcript was reused, not re-aligned

pass 4 — interrupt mid-image-generation, then resume
  ok   the interrupted run fails loudly
  ok   the first two images survived on disk
  ok   the resumed run completes the job
  ok   only the missing scenes were regenerated
  ok   the crash did not re-run the text stages

first pass:   13.0s
provider calls: {"writeStory":2,"verifyStory":2,"planScenes":2,"designCharacters":2,
                 "planSceneVisuals":8,"image":8,"tts":8,"align":8}
26/26 checks passed
```

The provider counts are cumulative across all four passes: one text run per job
(the smoke job and the separate interruption job), 4 images in pass 1, then
2 (crash) + 2 (resume).

Pass 4 is the requested crash test: the fake provider throws on the third image,
the job fails, two stills remain on disk, and the resume regenerates exactly
those two while reusing the finished text stages. `story-images.test.ts` and
`story-audio.test.ts` cover the same reuse rule per scene without a crash.

Real images (`ffmpeg -f lavfi color+drawbox`, 1920×1080, different palette and
box geometry per scene), real WAVs (`sine`, duration = words × 0.4 s ⇔ exactly
150 wpm), and a fake transcriber are used; every FFmpeg/ffprobe step is the
production code path.

### 4.4 The output file (real ffprobe)

```
$ ffprobe -v error -show_format -show_streams -of json final.mp4

format:  duration=31.000000  size=945711  bit_rate=244054
video:   codec_name=h264 profile=High width=1920 height=1080 pix_fmt=yuv420p
         r_frame_rate=30/1 avg_frame_rate=30/1 nb_frames=930 sample_aspect_ratio=1:1
audio:   codec_name=aac sample_rate=48000
```

S8 validation report (all 18 checks passed — every scene is now checked, not a
first/middle/last sample):

```
video_stream h264 1920x1080 yuv420p          ok
video_codec expected h264                    ok
pixel_format expected yuv420p                ok
resolution expected 1920x1080                ok
frame_rate expected 30 fps                   ok
audio_stream aac                             ok
audio_codec expected aac                     ok
duration_matches_audio 31.000 vs 31.000       ok
no_black_frames no interval > 0.6s (0 dark intervals seen)   ok
no_long_silence no silence > 1s at -50 dB                     ok
scene_1_shows_source correlation 1.000 with its own source; closest other scene 2 at 0.651   ok
scene_1_subtitles_visible band difference 7.55%   ok
scene_2_shows_source correlation 1.000; closest other scene 1 at 0.651                       ok
scene_2_subtitles_visible band difference 5.89%   ok
scene_3_shows_source correlation 1.000; closest other scene 4 at 0.665                       ok
scene_3_subtitles_visible band difference 6.67%   ok
scene_4_shows_source correlation 1.000; closest other scene 3 at 0.665                       ok
scene_4_subtitles_visible band difference 8.15%   ok
```

Why this check is no longer vacuous: a frame is compared against **every** scene
source, and the check passes only if its own source is the best match (within
1e-6). The details now print the closest competing scene (0.65 here), so the
discrimination is visible in the manifest. `SAMPLE_SCENE_COUNT` is 6 — every
scene of a ≤6-scene job is validated, and larger jobs get 6 evenly spaced
samples including the first and last.

### 4.5 Single-pass render — exact arguments

`buildRenderArgs()` produces exactly one video encode and one audio encode:

```js
[
  "-y",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  concatListPath, // image sequence + frame-snapped durations
  "-i",
  narrationPath, // the concatenated WAV
  "-vf",
  videoFilter, // scale/crop to 1080p (Lanczos cover) + subtitles=
  "-c:v",
  "libx264",
  "-crf",
  "19",
  "-preset",
  "medium",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "30",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-ar",
  "48000",
  "-ac",
  "2",
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-shortest",
  "-movflags",
  "+faststart",
  outputPath,
];
```

`-vf` is a single chain (verbatim, as built for the smoke job):

```
scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,
crop=1920:1080,setsar=1,fps=30,format=yuv420p,
subtitles=filename=/job/subtitles.ass:fontsdir=/pkg/assets/branding
```

The output is written to `render/final.tmp.mp4` and atomically renamed to
`final.mp4` only after S8 validation passes.

There is no intermediate video file: the concat demuxer feeds the encoder and the
subtitles are burned in the same pass. `-c:a aac` is the only audio encode (the
source is PCM WAV). `story-ffmpeg-args.test.ts` pins the single `libx264`, the
single `-vf`, and the absence of a second encode.

### 4.6 Aspect-ratio gate (DP4)

`validateSceneImage()` enforces, per still, before it is recorded as done:

- `width >= 1000 && height >= 540` (`STORY_IMAGE_MIN_*`)
- `1.6 <= width / height <= 1.9` (`STORY_IMAGE_MIN/MAX_ASPECT`)
- decodable by ffprobe, non-empty file, luminance variance ≥ 8 (blank/refusal)
- not byte-identical to an earlier scene's image

`story-images.test.ts` proves all six branches with real ffmpeg fixtures,
including the provider's native **1024×559** (aspect 1.832 — accepted, which is
the point: the provider ignores the size written in the prompt) and a
1200×1200 square (rejected on aspect alone). The manifest records `width`,
`height`, `aspect` and `luminanceVariance` for every generated still, so the
gate's verdict is auditable after the fact.

### 4.7 Subtitles produced by the smoke run

Eight cues for eight sentences, script text only, no overlaps, 200 ms gap
between scenes:

```
1  00:00:00,000 --> 00:00:04,000   Columbus stood on the deck / of a small wooden ship.
2  00:00:04,000 --> 00:00:07,600   The crew had not seen land for many days.
3  00:00:07,800 --> 00:00:10,600   They were tired, hungry, and very afraid.
4  00:00:10,600 --> 00:00:15,000   Some sailors wanted to turn / the ship around and go home.
5  00:00:15,200 --> 00:00:18,400   Columbus asked them to / wait one more night.
6  00:00:18,400 --> 00:00:22,400   That night a sailor saw / a small light far away.
7  00:00:22,600 --> 00:00:27,000   In the morning they found a / green island with tall trees.
8  00:00:27,000 --> 00:00:31,000   The long journey across the / wide sea was finally over.
```

### 4.8 Frame check and black detection, tuned for real illustrations

Two S8 checks were retuned after the review. Both are now covered by
`tests/story-render.test.ts` (10 cases, real FFmpeg fixtures).

**Frame-vs-source is a margin, not an absolute threshold.** Two stickman scenes
share a palette and line weight, so the correct frame can correlate strongly
with a neighbour. The rule is now: the frame must beat the best-scoring _other_
scene by `FRAME_MATCH_MARGIN = 0.02`, with a low sanity floor
(`MIN_FRAME_CORRELATION = 0.35`) so a blank frame still fails. Both sides mask
the subtitle band (`0 … 0.82` of the frame height), so burned-in captions cannot
tilt the comparison. The check is recorded as **severity `warning`**: a failure
appears in `manifest.warnings` and in the S8 report, but cannot fail the job
until the numbers have been tuned on real Gemini frames.

| Case                                   | Own  | Closest other | Margin | Result  |
| -------------------------------------- | ---- | ------------- | ------ | ------- |
| correct image, clear lead              | 0.82 | 0.71          | +0.11  | pass    |
| neighbour wins (wrong image on screen) | 0.86 | 0.88          | −0.02  | warning |
| correct but within tolerance           | 0.90 | 0.89          | +0.01  | warning |
| lone scene, resembles an illustration  | 0.55 | none          | —      | pass    |
| frame matches nothing                  | 0.10 | none          | —      | warning |

**Black detection now means "empty frame", not "dark frame".** The old filter
(`blackdetect=d=0.4:pix_th=0.10`) used FFmpeg's photographic defaults: pixels
below 10% luma counted as black. A pre-dawn or stormy stickman panel with a
large navy sky could trip it. The filter is now:

```
blackdetect=d=0.1:pix_th=0.05:picture_black_ratio_th=0.995
```

- `d=0.1` reports any run of 100 ms (the reviewer's suggested threshold), so a
  short gap is visible in the log instead of being invisible;
- `pix_th=0.05` only counts pixels below 5% luma as black;
- `picture_black_ratio_th=0.995` requires 99.5% of the frame to be black, so a
  thin white stickman or a moon on black is excluded;
- a reported interval must exceed `MAX_BLACK_SECONDS = 0.35` to fail the gate,
  which no legitimate illustration can reach under those settings, while a
  missing/blank source (a whole scene, ≥3 s) is caught.

Evidence from the suite (both run through the production `detectBlack`):

```
✓ ignores a dark night scene with a thin white figure   (2 s of RGB 0x0b1020 + white figure → [])
✓ still reports a genuinely black frame                 (2 s of black → one interval, > 1.5 s)
```

## 5. Duplication audit (module boundaries)

The brief asked for a pipeline "substantially simpler" than the Shorts graph, so
each story module was checked against the utilities that already exist:

| Story module     | Reuses                                                          | Verdict                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `media.ts`       | `execa` + ffprobe                                               | **Consolidated**: one `probeMedia()` returns streams _and_ duration. `render.ts` previously called the shared `probe()` **and** `probeStreams()` on the same file back to back, i.e. two subprocesses for one answer. Now one. |
| `ffmpeg-args.ts` | `staticScaleFilter`, `escapeSubtitlePath`, `runFfmpegWithRetry` | No duplication — pure argument builders, wrapped by the shared runner                                                                                                                                                          |
| `sentences.ts`   | (deliberately not) `splitNarrationSentences`                    | Script-aware superset: Urdu `۔`/`؟`, Devanagari `।`, CJK `。！？` are sentence terminators here and must not change Shorts behaviour. Documented in the module header; Latin cases stay covered by tests.                      |
| `prompt.ts`      | `hashObject` (fingerprints)                                     | No duplication — the story prompt is composed from slots + style profile, a different shape from the Shorts image prompts                                                                                                      |
| `subtitles.ts`   | `escapeSubtitlePath`, `hashObject`                              | Own ASS/SRT writer (1920×1080 playRes, no `force_style`) because the Shorts writer uses a different layout contract                                                                                                            |
| `timing.ts`      | —                                                               | New: fewer, measured scene boundaries replace the Shorts duration estimator                                                                                                                                                    |
| `alignment.ts`   | —                                                               | New: LCS with numeric spans and a proportional fallback                                                                                                                                                                        |
| `manifest.ts`    | `hashObject`                                                    | Own stage table (S1–S8) rather than the graph's node artifacts                                                                                                                                                                 |
| `lint.ts`        | `validateScriptComplexity` with optional thresholds             | Reused, with story thresholds passed in; defaults untouched                                                                                                                                                                    |

Net: the only real duplication found was the double ffprobe, and it is gone.
`sentences.ts` duplicates sentence-splitting _rules_ on purpose — merging them
would change the Shorts pipeline, which the brief forbids.

## 6. The real-provider run

### 6.1 What actually ran

`OPENROUTER_API_KEY` turned out to be configured in `apps/orchestrator/.env`, so
the entire **text** half of the pipeline was run against real OpenRouter models.
The writer prompt was then changed to state the measurable limits up front
(§6.4) and the run was repeated:

```
$ pnpm --filter youtube-shorts-orchestrator story \
    "Christopher Columbus's first voyage across the Atlantic" \
    --duration 45 --job-id real-llm-probe-c --out-dir /tmp/opencode/story-real4c \
    --stages S1_input,S2_story,S3_scenes,S4_visual_plan

status:   stopped        (exit 2 — stages S5–S8 were not requested)

stages: S1_input done · S2_story done · S3_scenes done · S4_visual_plan done
story:  116 words, 11 sentences, avg 10.5 words/sentence, max 17, grade 5.1,
        budget 113 (±15% → variance 2.7%), **1 attempt**, passed
claims: 8 in the ledger (established + legend, hedged where required)
verification: 1 attempt, 0 blocking, 1 advisory ("invented_motive": the story
        says Columbus was *certain*; the ledger only supports *believed*)
characters: 4 (columbus, the_crew, the_monarchs, islanders)
scenes: 6 (19, 21, 18, 25, 16, 17 words), grouping method "model",
        0 grouping issues
prompts: 6 composed prompts, 0 prompt-lint warnings
warnings: reading-grade advisory only (grade 5.1 against the story target of 4)
```

The previous run of the same pipeline (printing press) needed three attempts
and ended at 11.8 words/sentence; this one passed on the first draft at 10.5.
The single advisory is the reason the writer prompt now says: if a person
believed something, write "believed", never "was certain".

Manifest: `docs/story-sample-manifest-real-llm.json`.

### 6.2 What the real run broke (and what was fixed because of it)

| Finding                                                                           | Evidence                                                                                                                                | Fix                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The CLI could not see `.env` at all.**                                          | First real run: `Story writing failed: OPENROUTER_API_KEY not set in environment. Add to .env file.` although the key was in `.env`     | `scripts/story-video.mjs` loads the package `.env` and the IPv4 network runtime before importing the pipeline; `tests/story-cli.test.ts` pins the ordering                                                           |
| **`--duration` did nothing.**                                                     | `--duration 45` produced the 150 s plan (375 words) and the _same_ job id hash                                                          | The script wrote `targetDurationSec`; the config reads `duration`. Fixed, plus an exported `STORY_CLI_OVERRIDE_KEYS` contract that the CLI checks at startup, plus a test that the script's `assign()` keys match it |
| **Prompt lint rejected legitimate printing vocabulary.**                          | Every scene failed with `slot asks for readable text ("…")` because the rule matched bare nouns: _letters_, _words_, _printed_, _Bible_ | Rule narrowed to legibility _requests_ (`readable`, `the words of`, `text that reads`, `spelling out`, quoted copy). Regression cases use the exact failing props                                                    |
| **The lint then punished the model for obeying it.**                              | A real prop read "…shown as abstract shapes with **no readable letters**" and was flagged                                               | Negation-aware: a `no/without/instead of` in the same clause suppresses the match. Also reports the offending _phrase_ instead of the first 60 characters, which had hidden the cause                                |
| **The single verification rewrite lost the style constraints.**                   | Attempt 3 (triggered by `invented_motive`) averaged 15.3 words/sentence and the job hard-failed after spending its rewrite budget       | Every rewrite now carries a measurable style contract (avg ≤12 words, max 22, word budget ±15%). The next real run's third draft passed at 11.8/15                                                                   |
| **A trailing gap was appended after the last chunk.**                             | Master duration = Σchunks + _n_ × 200 ms instead of _n−1_; the last image lingered past the final word                                  | `buildNarrationConcatArgs` pads **between** chunks only; smoke duration 31.2 s → 31.0 s                                                                                                                              |
| **An undecodable TTS chunk surfaced as a raw ffprobe error.**                     | `story-audio.test.ts` empty-file case returned `FFprobe failed…` instead of the documented code                                         | The part probe is wrapped and rethrown as `STORY_TTS_INVALID`                                                                                                                                                        |
| **The schemas accepted a story with no claims ledger and whitespace-only slots.** | `story-schemas.test.ts`                                                                                                                 | `claims` is required; the four required slot strings are `.trim().min(1)` so the agent harness retries at the right layer                                                                                            |

### 6.3 What runs here (and what still does not)

The local half of the media pipeline was installed and run for real after the
review:

- **TTS:** Chatterbox 0.1.7 on PyTorch 2.6 (CPU), served on port 8010. The
  `ChatterboxTurboTTS` weights downloaded and loaded; six scene chunks were
  generated in 3 m 26 s on CPU.
- **Transcriber:** WhisperX 3.8.6 on PyTorch 2.8 (CPU) with the wav2vec2
  alignment model, served on port 8030. Forced alignment of all six chunks took
  12 s; the free ASR verification pass (§ below) adds ~30 s per chunk on CPU
  when it has to transcribe from scratch (3 m 00 s for six already-synthesized
  chunks in the latest S6 rerun).
- **Render:** the real FFmpeg single-pass render produced a 40.36 s 1080p
  H.264/AAC file (30 s for the all-real run, 48 s for the earlier fixture run).

**Images — real Gemini, once the browser profile was available.** The image
provider was started on 8020 with the profile copied from the main worktree and
reported `{"status":"ok","service":"gemini-image-provider","authenticated":true,"browserReady":true}`.
Six real images were then generated for the six scenes in **2 m 07 s**
(1024×572 and 1024×559, one attempt each, no refusals), so every stage of this
run is real: OpenRouter, Gemini, Chatterbox, WhisperX and FFmpeg.

**Capacity on this account.** The free tier stopped accepting generations after
roughly 14 images across the day's runs; after that the "+" menu showed
"Create image" with `aria-disabled="true"` and every request would have waited
out three generation timeouts. The provider now detects that state before
typing and answers `quota_exhausted` (non-retryable), and the story stage stops
the batch and names the scenes still missing an image, so a rerun after the
refill generates only those. At 2 m 07 s for six images, a 19-scene episode is
about 7 minutes of generation — the daily allowance, not the clock, is the
binding constraint. Treat ~14 as the number to confirm on the next refill.

**The Images surface is the live path.** Gemini now serves image creation at
`gemini.google.com/images`, and for accounts on that UI the "+" menu's
"Create image" entry stays disabled at all times — it is not a quota signal, so
the provider no longer treats it as one. Image requests enter the surface
through its sidebar route (a direct `/images` load redirects to `/app`) and
fall back to the menu. Two surface behaviours cost a day of probing and are now
handled: a prompt delivered as several editor blocks comes back as "I seem to
be encountering an error" (the same text flattened to one line generates
normally), and a finished generation navigates to its conversation, so the
composer has to be re-entered rather than assumed. The surface states a spent
allowance as "I can create more images as soon as your limit resets. Check your
usage in Settings.", which now classifies as `quota_exhausted`; the failure
scan also ignores the sidebar, whose past-conversation titles ("Rate Limit
Reached", "Failed Image Generation") otherwise look like the current run's
failure. With the port in place, six A/B prompts were regenerated headless in
about 50 s each.

**Publishing cadence.** The allowance, not the render, sets the schedule. A
19-scene episode needs 19 successful generations, so it cannot finish in one
free-tier day: it takes two runs (14 + 5), which is what `quota_exhausted` and
the resume path are for. Two days per episode leaves room for at most three a
week, and realistically **one to two** once retries, thumbnail drafts and any
style re-test share the same allowance. That is a production limit, not a
pipeline limit: a paid image path (Gemini API key or OpenRouter image models)
removes the ceiling at cents per episode and is the prerequisite for a
weekly-or-faster series. Confirm the refill number on the next reset before
committing to a schedule.

Reaching that point uncovered a real provider bug, fixed separately in
`fix(image-provider): insert multi-line prompts without submitting at newlines`.
The client typed the prompt with `keyboard.type()`, and Enter submits in
Gemini's composer, so a multi-line prompt was sent one paragraph per message and
only the first line reached the model. The evidence was unambiguous: a
2047-character story prompt produced a generic woodland illustration, and a
direct probe showed the chat bubble containing only
"A hand-drawn digital illustration in a simple children's storybook style."
Replacing the keystrokes with `keyboard.insertText()` sends the prompt once; the
same prompt then produced the intended lookout-at-the-mast image. The old path
was also very slow (2 kB ≈ 8 minutes of keystrokes); insertion is immediate.

What the real run still does **not** prove:

1. **Stickman style — resolved on 2026-10-21.** Two templates were compared on
   scenes 1, 4 and 5, with a second sample per arm on scenes 1 and 4 (six
   images, ~50 s each, headless). The candidates differed only in the opening
   line and the style-constraints sentence. Judged against four criteria —
   round white heads with line limbs and eyebrows-and-mouth faces, no clothing
   folds or shading, one silhouette cue per character, environment detail
   retained — the strict stick-figure template won scene 1 on both samples
   (named cues: beret, eyepatch, beanie, scarf, against identical grey-clothed
   figures) and was at least as good on 4 and 5. It is now the default in
   `prompts/story/style/stickman-history.json`, and the golden Columbus fixture
   still passes through the real profile and the real prompt linters. Both
   templates render the "keep the lower third calm" instruction as an empty
   band, which is what the subtitle strip needs.
2. **Listening — done.** The channel owner listened to the 40.36 s
   `final.mp4` on 2026-10-20 and judged the narration acceptable. That is a
   human sign-off, not a measurement: the free ASR pass proves the script words
   were spoken (coverage 1.00 on all six chunks) but says nothing about pacing
   or emphasis, so a listen stays on the checklist for each future episode.
3. **Refusal handling** (the single softening retry) is still only unit-tested:
   none of these six prompts was refused. Unit coverage is acceptable until the
   Gemini quota resets, but the real refusal path — a swords/mutiny scene the
   model declines, then the softened retry — has not run end to end and must
   before a violent-topic episode ships.

### 6.4 Writer limits moved from feedback to the prompt

The earlier printing-press run needed three story attempts: the first draft
averaged 15.3 words per sentence because the linter's numbers only reached the
model as _rewrite_ feedback. The story prompt now states the same measurable
limits before the first call, rendered from the lint thresholds so the two can
never drift:

```
Length and sentence limits
- Aim for about 12 words per sentence, averaged across the whole story.
- Never write a sentence longer than 22 words. Split it into two sentences instead.
- Keep the whole story between 96 and 130 words.       (45 s at 150 wpm, ±15%)
...
Before returning, re-read your story and count: no sentence may be above 22
words, and the whole story must stay between 96 and 130 words.
```

Result of the next real run: **1 attempt**, 10.5 words/sentence average, longest
sentence 17 words, 116 words (+2.7% of budget). The single verifier advisory was
about "certain" vs "believed"; the prompt now also says to match the strength of
the evidence and never upgrade "believed" to "was certain".

The first draft's violations, if a rewrite does happen, are now recorded in
`manifest.warnings` (previously they were only logged), so future tuning has the
actual numbers instead of a guess.

### 6.5 Real media run: S5–S8 on the real story

Every stage is a real provider call. The job resumed from the existing S1–S4
manifest, so no LLM call was repeated.

```
$ # services
$ (cd apps/tts && DEVICE=cpu venv/bin/python -m uvicorn app.main:app \
      --host 127.0.0.1 --port 8010)
$ (cd apps/transcriber && WHISPERX_DEVICE=cpu venv/bin/python -m uvicorn \
      app.main:app --host 127.0.0.1 --port 8030 --env-file .env)

$ pnpm --filter youtube-shorts-orchestrator story \
    "Christopher Columbus's first voyage across the Atlantic" \
    --duration 45 --job-id real-llm-probe-c --out-dir /tmp/opencode/story-real4c \
    --stages S6_audio,S7_align

Narration audio complete (3m 26s; includes the free ASR pass)
Alignment and subtitles complete (1m 34s)

$ # enabling verification on an existing job re-checks the chunks in place
$ pnpm --filter youtube-shorts-orchestrator story ... --from S6_audio
Narration audio complete (3m 00s for six chunks; no re-synthesis needed)

$ USE_REAL_PROVIDERS=true pnpm --filter youtube-shorts-orchestrator story \
    ... --stages S5_images --from S5_images
Scene images complete (2m 07s)

$ pnpm --filter youtube-shorts-orchestrator story \
    ... --stages S8_render --from S8_render
Render and validation complete (30s)
```

**Images — real Gemini**

```
scene  size        aspect  attempts  luminance variance
1      1024×572    1.79    1         3310
2      1024×559    1.83    1         1874
3      1024×572    1.79    1         1500
4      1024×572    1.79    1         5376
5      1024×572    1.79    1         2806
6      1024×572    1.79    1         2829
6 generated, 0 reused, 0 failed, 0 duplicate pairs
```

**Audio — real Chatterbox, six scene chunks**

```
scene  words  chunk duration
1      19     6.44 s
2      21     8.08 s
3      18     6.44 s
4      25     7.92 s
5      16     5.08 s
6      17     5.40 s
master: 40.36 s = 39.36 s of speech + 5 × 200 ms between-chunk gaps
no voice-outlier warnings, no chunk needed the 450-character split
```

The measured pace is ~172 wpm against the 150 wpm planning assumption, inside
the 0.5–2× plausibility band and inside the ±15% word budget, because the word
count was budgeted rather than the real speaking rate.

**Alignment — real WhisperX forced alignment, every scene at 1.00**

```
scene  timing                frames     method    matchRatio
1      0.000–6.633           0–199     aligned   1
2      6.633–14.933          199–448   aligned   1
3      14.933–21.567         448–647   aligned   1
4      21.567–29.667         647–890   aligned   1
5      29.667–34.967         890–1049  aligned   1
6      34.967–40.367         1049–1211 aligned   1
overall 1.00 · 11 cues · 0 proportional fallbacks
```

No tokenizer failure on this story (which contains a numeral phrase, a name and
an accented word, _Taíno_). The cue text is the script's, e.g.:

```
1  00:00:00,100 --> 00:00:03,792  The sailors had stared at empty ocean / for more than five weeks.
8  00:00:25,296 --> 00:00:29,246  They were the Taíno, and they came / down to the sand to meet the strangers.
11 00:00:35,027 --> 00:00:40,126  When they finally saw Spain again, the / sailors had a story no one in Europe had heard.
```

**Narration fidelity — one free ASR pass per chunk.** Forced alignment matches
the text it is given, so `matchRatio = 1` cannot prove the TTS actually said
every word. S6 therefore sends each finished chunk to the transcriber _again_,
without the script, and compares the free transcript to the narration
(`narrationFidelity`, same token matcher) while the TTS call is still the
freshest thing in the stage — that placement is what makes the retry below
possible. All six real chunks measure `coverage = 1.000` once spoken and
written numbers are canonicalised ("October eleventh" vs "October 11",
"fourteen ninety-two" vs "1492"); a deliberately dropped clause lands at 0.79.

A chunk below `ASR_COVERAGE_WARN = 0.85` is synthesized once more (same text,
same voice) and re-measured before anything is recorded; only a chunk that is
still below the line after that retry keeps a warning, and the warning is never
a gate. `STORY_ASR_VERIFY=false` skips the pass entirely. Reused chunks are
verified in place when verification is switched on later, and `asrChecked`
stops a resume from re-checking the same audio forever.

The threshold sits between the two real measurements available — six chunks at
1.00, one deliberately dropped clause at 0.79 (n = 7) — and is deliberately
advisory. Calibrate it against the next few real narrations before treating a
coverage number as evidence of a bad synthesis; the retry means a false
positive costs one wasted TTS call, not a failed run. The numeral canonicalisation is English-specific;
another language would need its own number-word rules before the coverage
number means what it says.

**Render — real single pass, real validation**

```
format: duration=40.360000 size=3484175 bit_rate=690619
video:  h264 1920x1080 yuv420p 30/1 nb_frames=1210
audio:  aac 48000 Hz
validation passed: 18 checks (12 gate + 6 warning scene checks)
duration_matches_audio: video 40.360 s vs audio 40.360 s
no_black_frames: no interval longer than 0.35 s (0 dark intervals seen)
no_long_silence:  no silence longer than 1 s at -50 dB
frame check:      own 1.000 vs closest other 0.154–0.366 (margin 0.634–0.846)
subtitle band:    2.53%–6.33% difference (gate >= 0.50%)
```

The job was killed once mid-S8 by a harness restart. On resume, S8 reran (its
status was `running`) and S1–S7 were all reused, which is the documented crash
behaviour; the stale `render/final.tmp.mp4` was overwritten and only the
validated file was renamed to `final.mp4`.

Manifest: `docs/story-sample-manifest-real-media.json` — every stage real
(OpenRouter story, Gemini images, Chatterbox narration, WhisperX alignment,
FFmpeg render).

## 7. Known limitations and deliberate choices

1. **Subtitle minimum duration yields to no-overlap.** When two cues are closer
   than `STORY_SUBTITLE_MIN_DURATION_MS`, the earlier cue is clamped to the next
   cue's start, so it may display for less than the minimum. Overlap would be
   worse; asserted in `story-subtitles.test.ts`.
2. **Cut accuracy** comes from the transcriber's word timings (LCS-aligned to the
   script), so a ±1 word boundary error is possible on a noisy chunk; the
   proportional fallback is used when a chunk's match ratio drops below
   `SCENE_ALIGNMENT_GATE`.
3. **Image-provider contract.** `/generate` accepts only `prompt`, `type`,
   `mode`, and up to 4 `referenceImages`; the 16:9 size is requested in the
   prompt text and enforced by the post-generation gate, not by a provider
   parameter.
4. **Concurrency.** `STORY_IMAGE_CONCURRENCY` defaults to 1 because the provider
   drives a logged-in browser session. S4 visual planning uses a fixed in-flight
   limit of 2.
5. **`STORY_REFERENCE_SHEET`** (a character reference sheet passed to the image
   provider) exists in config and is fingerprinted, but is off by default and was
   not exercised end to end.
6. **Reading grade is advisory.** The brief makes grade 6–8 advisory for story
   mode; a real run warned at 6.4 and continued (lint passed).
7. **Prompt versioning.** Story prompts are pinned to v1 independently of
   `PROMPT_VERSION`; changing a prompt changes the stage fingerprint and
   regenerates only the affected artifacts.
8. **Style fidelity — closed.** The strict stick-figure template won a two-arm
   comparison and is now the default (§6.5). The risk that remains is drift
   across a long episode, which the 19-scene run is meant to measure.
9. **Resolution.** The provider returns 1024×559–572 stills regardless of the
   1920×1080 request in the prompt; the render upscales them, so frames are
   slightly soft. The `>= 1000×540` gate is what the provider can actually meet.
10. **The provider cache is versioned, not cleared by hand.** Cache keys hash a
    manual `CACHE_KEY_VERSION` (currently `v2`) plus the prompt, so a delivery
    or model fix that leaves the prompt text unchanged still misses stale
    entries. `v2` invalidates everything generated before multi-line prompts
    were inserted in full.
11. **Narration verification is advisory.** The free ASR pass proves the words
    were spoken, not that the performance is good: pace, emphasis and
    mispronunciation of names are still listening-test territory. Number
    handling is heuristic (two two-digit groups read as a year) and
    English-specific, so a number run the heuristic misreads can consume
    coverage headroom — it cannot fail the run. A low-coverage chunk gets one
    automatic re-synthesis before the check gives up.

## 8. Reproduce

```bash
# gates
pnpm --filter youtube-shorts-orchestrator build
pnpm --filter youtube-shorts-orchestrator typecheck
pnpm lint                      # needs a ruff on PATH or the app venvs
pnpm format:check
pnpm --filter youtube-shorts-orchestrator exec node --experimental-vm-modules \
  node_modules/jest/bin/jest.js

# end-to-end (fake agents/providers, real FFmpeg/ffprobe) — 4 passes
node apps/orchestrator/scripts/story-smoke.mjs

# dry run (exit 0), then a real job when the provider services are up
pnpm --filter youtube-shorts-orchestrator story "The mutiny on the Bounty" --duration 45 --dry-run
pnpm --filter youtube-shorts-orchestrator story "The mutiny on the Bounty" --duration 45
```
