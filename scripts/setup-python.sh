#!/usr/bin/env bash
# Creates the Python venvs for the standalone services and copies missing
# .env files. Idempotent: safe to run repeatedly (the second run is fast and
# destructive only if --upgrade-deps is passed).
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3.11}"
UPGRADE_DEPS=0
SERVICES=(apps/tts apps/transcriber)
UPGRADED=()
CREATED=()

usage() {
  cat <<'USAGE'
Usage: bash scripts/setup-python.sh [--upgrade-deps]

  --upgrade-deps   re-run pip install for every service (slow; only when you
                   want to refresh pinned dependencies)
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --upgrade-deps) UPGRADE_DEPS=1 ;;
    -h | --help) usage; exit 0 ;;
    *)
      printf 'Unknown option: %s\n\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

log() { printf '\n[setup] %s\n' "$1"; }
warn() { printf '[setup] WARNING: %s\n' "$1" >&2; }

# --- preflight ---------------------------------------------------------------
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  printf 'ERROR: %s not found. These services require Python 3.11.\n' "$PYTHON_BIN" >&2
  exit 1
fi

PYTHON_VERSION="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if [ "$PYTHON_VERSION" != "3.11" ]; then
  warn "$PYTHON_BIN is Python $PYTHON_VERSION, not 3.11 (venvs are still created, but 3.11 is the supported version)."
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  warn "ffmpeg not found — audio concatenation and video composition will fail. Not fatal for setup."
fi

# --- .env files --------------------------------------------------------------
# Only ever created when missing, so an existing .env (with real secrets) is
# never overwritten.
ensure_env_file() {
  local service_dir="$1"
  if [ -f "$ROOT_DIR/$service_dir/.env" ]; then
    return
  fi
  if [ ! -f "$ROOT_DIR/$service_dir/.env.example" ]; then
    warn "no .env.example for $service_dir — skipping env setup"
    return
  fi
  cp "$ROOT_DIR/$service_dir/.env.example" "$ROOT_DIR/$service_dir/.env"
  CREATED+=("$service_dir/.env")
}

# --- venvs -------------------------------------------------------------------
# A venv only counts as done when its stamp matches the current interpreter and
# requirements. An interrupted run leaves a venv that looks complete, and
# skipping on venv-existence alone would silently hide a half-installed
# service from then on.
requirements_stamp() {
  local service_dir="$1"
  cat "$ROOT_DIR/$service_dir/requirements.txt" \
    "$ROOT_DIR/$service_dir/dev-requirements.txt" 2>/dev/null | sha256sum | cut -d' ' -f1
}

setup_service() {
  local service_dir="$1"
  local venv="$ROOT_DIR/$service_dir/venv"
  local stamp="$venv/.setup-stamp"
  local expected="$PYTHON_VERSION:$(requirements_stamp "$service_dir")"

  if [ -x "$venv/bin/python" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$expected" ]; then
    if [ "$UPGRADE_DEPS" -eq 1 ]; then
      log "upgrading dependencies for $service_dir"
      "$venv/bin/python" -m pip install --upgrade -r "$ROOT_DIR/$service_dir/requirements.txt"
      "$venv/bin/python" -m pip install --upgrade -r "$ROOT_DIR/$service_dir/dev-requirements.txt"
      UPGRADED+=("$service_dir")
    else
      log "skipping $service_dir (already set up — pass --upgrade-deps to refresh)"
    fi
    return
  fi

  local reason="creating"
  if [ -x "$venv/bin/python" ]; then
    reason="repairing incomplete setup for"
  fi
  log "$reason $service_dir"
  "$PYTHON_BIN" -m venv "$venv"
  "$venv/bin/python" -m pip install --upgrade pip
  "$venv/bin/python" -m pip install -r "$ROOT_DIR/$service_dir/requirements.txt"
  "$venv/bin/python" -m pip install -r "$ROOT_DIR/$service_dir/dev-requirements.txt"
  printf '%s\n' "$expected" > "$stamp"
  CREATED+=("$service_dir/venv")
}

log "Python $PYTHON_VERSION via $PYTHON_BIN"

for service_dir in "${SERVICES[@]}"; do
  ensure_env_file "$service_dir"
done

for service_dir in "${SERVICES[@]}"; do
  setup_service "$service_dir"
done

# --- summary -----------------------------------------------------------------
log "done"
if [ "${#CREATED[@]}" -gt 0 ]; then
  printf '  created: %s\n' "${CREATED[*]}"
fi
if [ "${#UPGRADED[@]}" -gt 0 ]; then
  printf '  upgraded: %s\n' "${UPGRADED[*]}"
fi
skipped=()
for service_dir in "${SERVICES[@]}"; do
  if [ "${#CREATED[@]}" -eq 0 ]; then
    skipped+=("$service_dir")
    continue
  fi
  already=0
  for created in "${CREATED[@]}"; do
    [ "$created" = "$service_dir/venv" ] && already=1
  done
  [ "$already" -eq 0 ] && skipped+=("$service_dir")
done
printf '  skipped: %s\n' "${skipped[*]:-none}"
printf '  note: set OPENROUTER_API_KEY in apps/orchestrator/.env for real LLM calls.\n'
