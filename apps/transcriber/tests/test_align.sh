#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_BIN="${ROOT}/venv/bin"
PORT_WAS_SET=0
if [[ -n "${PORT:-}" ]]; then
  PORT_WAS_SET=1
fi

if [[ -z "${PORT:-}" ]]; then
  PORT="$(${VENV_BIN}/python - <<'PY'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
fi

BASE="http://localhost:${PORT}"
export WHISPERX_LANGUAGE="${WHISPERX_LANGUAGE:-en}"
export WHISPERX_FORCE_TRANSCRIBE=0

SAMPLE_WAV="${ROOT}/tests/sample_narration.wav"
SAMPLE_TEXT="The quick brown fox jumps over the lazy dog. This sample narration is generated to test word level timestamp alignment. Every spoken word should receive an accurate start and end time."

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$SAMPLE_WAV"
}
trap cleanup EXIT

if [[ "$PORT_WAS_SET" == "1" ]] && lsof -tiTCP:${PORT} -sTCP:LISTEN > /dev/null 2>&1; then
  echo "Port ${PORT} already occupied; refusing to test stale server."
  exit 1
fi

echo "== Generating sample WAV =="
bash "${ROOT}/tests/make_sample.sh" "$SAMPLE_TEXT" "$SAMPLE_WAV"

echo "== Starting server on :${PORT} =="
(
  cd "$ROOT"
  exec "${VENV_BIN}/python" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" \
    > /tmp/whisperx_test_server.log 2>&1
) &
SERVER_PID=$!

for _ in $(seq 1 120); do
  if curl -fsS "${BASE}/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server died. Log:"
    cat /tmp/whisperx_test_server.log
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "${BASE}/health" > /dev/null 2>&1; then
  echo "Server did not become ready on :${PORT}."
  echo "Server log:"
  cat /tmp/whisperx_test_server.log
  exit 1
fi

echo "== /health =="
HEALTH_JSON="$(curl -fsS "${BASE}/health")"
echo "$HEALTH_JSON"
"${VENV_BIN}/python" - "$HEALTH_JSON" <<'PY'
import json
import sys

health = json.loads(sys.argv[1])
assert health["status"] == "ok"
assert health["alignment_model_loaded"] is True
assert health["asr_loaded"] is False
PY
echo

echo "== /align =="
"${VENV_BIN}/python" - "${SAMPLE_WAV}" "${BASE}/align" "$SAMPLE_TEXT" <<'PY'
import json
import subprocess
import sys
import urllib.request
import uuid

wav_path, url, text = sys.argv[1], sys.argv[2], sys.argv[3]

boundary = uuid.uuid4().hex
audio_data = open(wav_path, "rb").read()
body = bytearray()

def field(name, value):
    return (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
        f"{value}\r\n"
    ).encode()

def file_field(name, filename, content):
    return (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode() + content + b"\r\n"

body += field("text", text)
body += file_field("audio", "narration.wav", audio_data)
body += f"--{boundary}--\r\n".encode()

request = urllib.request.Request(
    url,
    data=bytes(body),
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)

with urllib.request.urlopen(request, timeout=600) as response:
    result = json.loads(response.read().decode())

duration = result["duration"]
words = result["words"]
expected_duration = float(subprocess.check_output([
    "ffprobe", "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", wav_path,
]).decode())

assert words, "no word timestamps returned"
assert duration > 0, "duration must be positive"
assert abs(duration - expected_duration) <= 0.05, (
    f"duration mismatch: service={duration:.3f}s "
    f"wav={expected_duration:.3f}s"
)

for word in words:
    assert 0.0 <= word["start"] < word["end"] <= duration, (
        f"timestamp out of range: {word}"
    )

starts = [word["start"] for word in words]
assert all(starts[i] <= starts[i + 1] for i in range(len(starts) - 1)), (
    "word timestamps not monotonic"
)

expected = len(text.split())
ratio = min(1.0, len(words) / max(expected, 1))
assert ratio >= 0.8, (
    f"too few supplied words aligned: {len(words)}/{expected} (ratio={ratio:.3f})"
)

last_end = words[-1]["end"]
assert last_end <= duration, "last word end exceeds duration"

trailing_silence = duration - last_end
assert 0.0 <= trailing_silence <= duration
assert trailing_silence <= 2.0, (
    f"last word is too far from speech end: trailing silence={trailing_silence:.3f}s"
)

print(f"duration={duration:.2f}s")
print(f"language={result['language']}")
print(f"words={len(words)}")
print(f"word_count_ratio={ratio:.3f}")
print(f"first_word={words[0]}")
print(f"last_word={words[-1]}")
print(f"last_word_end={last_end:.3f}s")
print(f"trailing_silence={trailing_silence:.3f}s")
print("OK")
PY

echo "== /health after known-text alignment =="
HEALTH_JSON="$(curl -fsS "${BASE}/health")"
echo "$HEALTH_JSON"
"${VENV_BIN}/python" - "$HEALTH_JSON" <<'PY'
import json
import sys

health = json.loads(sys.argv[1])
assert health["alignment_model_loaded"] is True
assert health["asr_loaded"] is False
PY

echo "== test passed =="
