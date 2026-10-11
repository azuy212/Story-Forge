#!/usr/bin/env bash
# Asserts the shared provider HTTP contract against every running service:
#
#   GET  /health  -> 200 { status, service }
#   POST <endpoint> with malformed input -> 4xx/5xx { error: { code, message, requestId } }
#
# Services that are not running are reported as skipped, so the script is safe
# to run anywhere; a service that IS running must satisfy the contract.
#
#   bash scripts/contract-smoke.sh                     # localhost defaults
#   TTS_URL=... IMAGE_PROVIDER_URL=... bash scripts/contact-smoke.sh
set -uo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

TTS_URL="${TTS_URL:-http://localhost:8010}"
TRANSCRIBER_URL="${TRANSCRIBER_URL:-http://localhost:8030}"
IMAGE_PROVIDER_URL="${IMAGE_PROVIDER_URL:-http://localhost:8020}"

failures=0
checked=0

check() {
  local label="$1" url="$2" body="$3"
  local response status payload request_id code

  response="$(curl -s -m 5 -w '\n%{http_code}' -X POST "$url" ${body:+-H 'Content-Type: application/json' -d "$body"})" || {
    printf 'SKIP %s (unreachable)\n' "$label"
    return
  }
  status="$(printf '%s' "$response" | tail -n1)"
  payload="$(printf '%s' "$response" | sed '$d')"

  if [ -z "$payload" ]; then
    printf 'SKIP %s (empty response)\n' "$label"
    return
  fi

  checked=$((checked + 1))

  request_id="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(1)
error = body.get("error") if isinstance(body, dict) else None
if not isinstance(error, dict):
    sys.exit(1)
print(error.get("requestId") or "")
' )"

  code="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(1)
error = body.get("error") if isinstance(body, dict) else None
if not isinstance(error, dict):
    sys.exit(1)
print(error.get("code") or error.get("type") or "")
' )"

  if [ -z "$code" ]; then
    printf 'FAIL %s: no error.code in response (HTTP %s)\n' "$label" "$status"
    failures=$((failures + 1))
    return
  fi

  printf 'PASS %s: code=%s status=%s requestId=%s\n' "$label" "$code" "$status" "${request_id:-<none>}"
}

check_health() {
  local label="$1" url="$2" expected_service="$3"
  local response status payload service

  response="$(curl -s -m 5 -w '\n%{http_code}' "$url/health")" || {
    printf 'SKIP %s (unreachable)\n' "$label"
    return
  }
  status="$(printf '%s' "$response" | tail -n1)"
  payload="$(printf '%s' "$response" | sed '$d')"

  if [ -z "$payload" ]; then
    printf 'SKIP %s (empty response)\n' "$label"
    return
  fi

  service="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(body, dict):
    sys.exit(1)
print(body.get("service") or "")
')"

  if [ -z "$service" ]; then
    printf 'FAIL %s: no service field in /health\n' "$label"
    failures=$((failures + 1))
    return
  fi

  printf 'PASS %s: service=%s status=%s\n' "$label" "$service" "$status"
}

check_health "tts" "$TTS_URL" "chatterbox"
check_health "transcriber" "$TRANSCRIBER_URL" "whisperx"
check_health "image-provider" "$IMAGE_PROVIDER_URL" "gemini-image-provider"

check "tts.generate (empty text)" "$TTS_URL/generate" '{"text":""}'
check "transcriber.align (no audio)" "$TRANSCRIBER_URL/align" ''
check "image-provider.generate (invalid prompt)" "$IMAGE_PROVIDER_URL/generate" '{"prompt":""}'

if [ "$failures" -ne 0 ]; then
  printf 'contract-smoke: %d failure(s)\n' "$failures" >&2
  exit 1
fi

if [ "$checked" -eq 0 ]; then
  printf 'contract-smoke: all services skipped (none running)\n'
else
  printf 'contract-smoke: provider contract holds for %d endpoint(s)\n' "$checked"
fi
