#!/usr/bin/env bash
set -euo pipefail

TEXT="${1:?usage: make_sample.sh <text> [output.wav]}"
OUT="${2:-narration.wav}"

TMP_AIFF="$(mktemp -t narration).aiff"

cleanup() {
  rm -f "$TMP_AIFF"
}
trap cleanup EXIT

say -v Samantha "$TEXT" -o "$TMP_AIFF"

ffmpeg -y -i "$TMP_AIFF" \
  -ar 24000 -ac 1 -c:a pcm_f32le \
  "$OUT" 2>/dev/null

ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,sample_fmt \
  -of default=noprint_wrappers=1 "$OUT"

echo "Created: $OUT"
