# WhisperX Alignment Service

Local HTTP service around WhisperX. Accepts narration WAV + known transcript, returns word-level timestamps.

```
WAV + narration text  →  POST /align  →  word timestamps
```

No subtitle generation here. Consumer (LangGraph) converts timestamps to SRT/ASS.

## Endpoints

### POST /align

Multipart form data:

- `audio` — WAV file (required)
- `text` — known narration transcript (optional)

```bash
curl -X POST http://localhost:8030/align \
  -F "audio=@narration.wav" \
  -F "text=The narration text goes here."
```

Response:

```json
{
  "duration": 57.84,
  "language": "en",
  "segments": [
    {
      "start": 0.0,
      "end": 2.1,
      "text": "The narration begins here.",
      "words": [
        {"word": "The", "start": 0.0, "end": 0.31, "score": 0.98}
      ]
    }
  ],
  "words": [
    {"word": "The", "start": 0.0, "end": 0.31, "score": 0.98}
  ]
}
```

Top-level `words` is the primary output for subtitle generation.

### GET /health

```bash
curl http://localhost:8030/health
```

```json
{
  "status": "ok",
  "alignment_model_loaded": true,
  "asr_loaded": false,
  "device": "mps",
  "asr_device": "cpu",
  "compute_type": "int8",
  "model": "large-v3",
  "language": "en"
}
```

`alignment_model_loaded` = alignment model resident.
`asr_loaded` = Whisper ASR resident (only after first request that needed transcription).

## Alignment behavior

When `text` is supplied:

1. Forced-align the supplied transcript against the actual WAV (wav2vec2).
2. Whisper ASR is **not** run — timestamps come from the audio, not transcription.
3. Language comes from `WHISPERX_LANGUAGE`.

When `text` is missing, or `WHISPERX_FORCE_TRANSCRIBE=1`:

1. Whisper ASR transcribes the WAV.
2. Detected language + segments are aligned.
3. Word timestamps returned.

When `text` is supplied without `WHISPERX_LANGUAGE`, and forced transcription is disabled, the service returns HTTP 400. Set the language for pure forced alignment, or set `WHISPERX_FORCE_TRANSCRIBE=1` to let ASR detect it.

Timestamps are produced by forced alignment over the real waveform. No character-count, word-count, or fixed-speaking-rate estimation.

Timing semantics: `duration` = actual WAV duration. `last word end` = actual end of speech and is `<= duration` (trailing silence in the WAV is not speech). Smoke test narration uses a 2-second maximum trailing-silence tolerance, checking speech reaches near known WAV end instead of only checking `last word end <= duration`.

## Quality validation

After alignment the service validates:

- words exist
- timestamps finite
- `0 <= start < end <= duration`
- timestamps monotonic
- word-count ratio telemetry when known transcript is supplied

On failure: HTTP 500, no fake timestamps returned.

`word_count_ratio` (aligned words / supplied transcript words, clamped to 1.0) is logged per request as telemetry. WhisperX word segmentation can differ from supplied transcript, so this is a rough sanity metric, not true coverage. No word-count quality gate is configured in v1. Use real Chatterbox samples before adding any quality metric.

## Device handling

- `WHISPERX_DEVICE=auto` — MPS if available, else CPU (default)
- `WHISPERX_DEVICE=mps` — MPS, falls back to CPU if unavailable
- `WHISPERX_DEVICE=cpu` — CPU

Whisper ASR (ctranslate2 backend) always runs on CPU regardless of this setting. The wav2vec2 alignment model runs on the configured device.

## Configuration

Environment variables:

```
WHISPERX_MODEL=large-v3
WHISPERX_DEVICE=auto
WHISPERX_COMPUTE_TYPE=int8
WHISPERX_LANGUAGE=en
WHISPERX_FORCE_TRANSCRIBE=0
```

Copy `.env.example` → `.env` to change defaults without touching source. Run uvicorn with `--env-file .env` if you want the file loaded.

## Run

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

uvicorn app.main:app --host 0.0.0.0 --port 8030 --env-file .env
```

Model lifecycle:

- **Startup** — wav2vec2 alignment model loads once and stays resident; Whisper ASR is not loaded.
- **`/align` with known text + language, `FORCE_TRANSCRIBE=0`** — alignment model only; Whisper ASR remains unloaded.
- **`/align` without text (or forced)** — Whisper ASR loads lazily on first use, then stays resident.

## Tests

Generate a sample narration WAV (macOS `say` TTS → 24 kHz mono float32):

```bash
bash tests/make_sample.sh \
  "This is a sample narration generated for testing the alignment service." \
  narration.wav
```

Smoke test (starts server, health check, align, cleanup):

```bash
bash tests/test_align.sh
```

Or manually:

```bash
curl http://localhost:8030/health

curl -X POST http://localhost:8030/align \
  -F "audio=@narration.wav" \
  -F "text=YOUR NARRATION TEXT"
```

## Project structure

```
app/
├── main.py              FastAPI app, HTTP concerns
├── config.py            environment config + device resolution
├── whisperx_engine.py   WhisperX model lifecycle, alignment, validation
└── schemas.py           response models
tests/
├── make_sample.sh
└── test_align.sh
```

## Errors

| Status | Case |
| ------ | ---- |
| 400    | missing audio or missing language for supplied text |
| 422    | audio decode failure |
| 500    | alignment/WhisperX processing failure |

No HTTP 200 with fake or empty timestamps.
