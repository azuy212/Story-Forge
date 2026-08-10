#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

ensure_env_file() {
  local service_dir="$1"
  if [ ! -f "$ROOT_DIR/$service_dir/.env" ]; then
    cp "$ROOT_DIR/$service_dir/.env.example" "$ROOT_DIR/$service_dir/.env"
  fi
}

setup_service() {
  local service_dir="$1"
  local requirements="$2"
  local venv="$ROOT_DIR/$service_dir/venv"

  if [ ! -x "$venv/bin/python" ]; then
    python3.11 -m venv "$venv"
  fi

  "$venv/bin/python" -m pip install --upgrade pip
  "$venv/bin/python" -m pip install -r "$ROOT_DIR/$service_dir/$requirements"
}

ensure_env_file "apps/orchestrator"
ensure_env_file "apps/tts"
ensure_env_file "apps/image-provider"
ensure_env_file "apps/transcriber"

setup_service "apps/tts" requirements.txt
"$ROOT_DIR/apps/tts/venv/bin/python" -m pip install -r "$ROOT_DIR/apps/tts/dev-requirements.txt"
setup_service "apps/transcriber" requirements.txt

printf '%s\n' "Python environments ready. Set OPENROUTER_API_KEY in apps/orchestrator/.env."
