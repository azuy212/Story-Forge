#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

run_ruff() {
  local service="$1"
  local venv_ruff="$ROOT_DIR/apps/$service/venv/bin/ruff"

  if [ -x "$venv_ruff" ]; then
    "$venv_ruff" check "apps/$service"
  elif command -v ruff >/dev/null 2>&1; then
    ruff check "apps/$service"
  else
    printf 'Ruff not found. Run pnpm run setup:all or install Ruff.\n' >&2
    return 1
  fi
}

run_ruff "tts"
run_ruff "transcriber"
