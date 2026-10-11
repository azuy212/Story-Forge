#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Runs the Python unit suites for each standalone service (the orchestrator is
# covered by Jest). Mirrors lint-python.sh: prefer the service venv, fall back
# to a system pytest.

status=0

for service in tts transcriber; do
  venv_python="$ROOT_DIR/apps/$service/venv/bin/python"

  if [ -x "$venv_python" ]; then
    echo "Running pytest for $service (venv)"
    # Run from the service directory: `app.*` imports resolve the way the
    # service itself is started (see AGENTS.md setup/verification notes).
    if ! (cd "apps/$service" && "$venv_python" -m pytest tests -q); then
      status=1
    fi
  elif command -v pytest >/dev/null 2>&1; then
    echo "Running pytest for $service (system pytest)"
    if ! (cd "apps/$service" && pytest tests -q); then
      status=1
    fi
  else
    echo "pytest not found for $service. Run pnpm run setup:all or install pytest." >&2
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "Python tests failed." >&2
  exit 1
fi

echo "Python tests passed."
