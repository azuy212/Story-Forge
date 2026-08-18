#!/usr/bin/env bash
set -euo pipefail

resolve_binary() {
  local configured="$1"
  local name="$2"

  if [[ -n "$configured" ]]; then
    printf '%s\n' "$configured"
    return
  fi

  local candidate
  for candidate in \
    "/opt/homebrew/opt/ffmpeg-full/bin/$name" \
    "/usr/local/opt/ffmpeg-full/bin/$name" \
    "/home/linuxbrew/.linuxbrew/opt/ffmpeg-full/bin/$name"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  command -v "$name" 2>/dev/null || true
}

ffmpeg_bin="$(resolve_binary "${FFMPEG_PATH:-}" ffmpeg)"
ffprobe_bin="$(resolve_binary "${FFPROBE_PATH:-}" ffprobe)"

if [[ -z "$ffmpeg_bin" || -z "$ffprobe_bin" ]]; then
  printf 'FFmpeg and ffprobe are required. On macOS run: brew install ffmpeg-full\n' >&2
  exit 1
fi

filters="$("$ffmpeg_bin" -hide_banner -filters 2>&1)"
missing=()
for filter in drawtext subtitles; do
  if ! grep -Eq "[[:space:]]${filter}[[:space:]]" <<<"$filters"; then
    missing+=("$filter")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'The selected FFmpeg (%s) is missing required filter(s): %s\n' \
    "$ffmpeg_bin" "${missing[*]}" >&2
  printf 'On macOS install the full build with: brew install ffmpeg-full\n' >&2
  printf 'Or set FFMPEG_PATH and FFPROBE_PATH to compatible binaries.\n' >&2
  exit 1
fi

printf 'FFmpeg media checks passed: %s\n' "$ffmpeg_bin"
