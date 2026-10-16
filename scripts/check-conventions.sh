#!/usr/bin/env bash
# Mechanical enforcement of the AGENTS.md orchestrator conventions.
#
# Every check is fail-closed: a violation blocks `pnpm lint`. Allowlists are
# explicit so adding a legitimate new reader is a deliberate edit to this file
# rather than a silent widening.
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ORCH="$ROOT_DIR/apps/orchestrator/src"

failures=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

# --- 1. No process.env outside the config boundary -------------------------
# `utils/config.ts` is the only reader that should exist. run-log, artifacts
# and the thumbnail compositor are pre-existing infrastructure readers, not
# agent nodes; adding a new one here requires deliberate justification.
ALLOWED_ENV_READERS=(
  "apps/orchestrator/src/utils/config.ts"
  "apps/orchestrator/src/utils/run-log.ts"
  "apps/orchestrator/src/artifacts/namespace.ts"
  "apps/orchestrator/src/providers/thumbnail-compositor.ts"
)

while IFS= read -r file; do
  allowed=0
  for entry in "${ALLOWED_ENV_READERS[@]}"; do
    if [ "$file" = "$entry" ]; then
      allowed=1
      break
    fi
  done
  if [ "$allowed" -eq 0 ]; then
    fail "process.env outside the config boundary: $file (read through utils/config.ts)"
  fi
done < <(cd "$ROOT_DIR" && grep -rln "process\.env" apps/orchestrator/src --include="*.ts")

# --- 2. No jest.mock() in orchestrator tests -------------------------------
# Tests inject mocks via RunnableConfig.configurable instead.
if (cd "$ROOT_DIR" && grep -rln "jest\.mock(" apps/orchestrator/tests --include="*.ts"); then
  fail "jest.mock() is banned in orchestrator tests; inject mocks via config.configurable"
fi

# --- 3. Relative imports keep an explicit ESM specifier --------------------
# `.js` is required; `.mjs` is allowed for the script bridges.
while IFS= read -r hit; do
  file="${hit%%:*}"
  spec="$(printf '%s' "$hit" | sed -n 's/.*from "\([^"]*\)".*/\1/p')"
  case "$spec" in
    *.js | *.mjs) ;;
    *) fail "relative import without .js/.mjs specifier: ${file#"$ROOT_DIR"/} -> $spec" ;;
  esac
done < <(grep -rn 'from "\.' "$ORCH" --include="*.ts")

# --- 4. Zod v4 records need a key and a value type ------------------------
# Structural check: argument splitting has to respect nested parens, so this
# one is not a plain grep.
zod_failures="$(python3 - "$ORCH" << 'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
problems = []

for path in sorted(root.rglob("*.ts")):
    text = path.read_text()
    for match in re.finditer(r"z\.record\(", text):
        start = match.end()
        depth = 1
        index = start
        while index < len(text) and depth:
            char = text[index]
            if char in "([{":
                depth += 1
            elif char in ")]}":
                depth -= 1
            index += 1
        args = text[start : index - 1].strip()
        if args.endswith(","):
            args = args[:-1].strip()

        depth = 0
        commas = 0
        for char in args:
            if char in "([{":
                depth += 1
            elif char in ")]}":
                depth -= 1
            elif char == "," and depth == 0:
                commas += 1
        if commas != 1:
            line = text[: match.start()].count("\n") + 1
            problems.append(f"{path}:{line}")

for problem in problems:
    print(problem)
PY
)"

if [ -n "$zod_failures" ]; then
  while IFS= read -r hit; do
    fail "z.record() must take a key and a value schema: ${hit#"$ROOT_DIR"/}"
  done < <(printf '%s\n' "$zod_failures")
fi

# --- 5. No instanceof checks against framework base classes in agents ------
# Use the duck-type guards in src/utils/errors.ts instead.
if (cd "$ROOT_DIR" && grep -rn "instanceof BaseChatModel\|instanceof LangChainError" apps/orchestrator/src/agents --include="*.ts"); then
  fail "instanceof on framework base classes is banned in agents; use the duck-type guards in utils/errors.ts"
fi

# --- 6. ESM only: no CommonJS constructs in workspace sources ----------------
# Every workspace package is "type": "module" and compiled to ESM. A bare
# __dirname is the ESM-correct local (derived from import.meta.url), which is
# allowed; a CJS require/module.exports is not.
cjs_hits="$(grep -rn -e 'require(' -e 'module\.exports' -e '^exports\.' \
  apps/orchestrator/src apps/image-provider/src apps/image-provider/tests \
  apps/admin-ui/server apps/admin-ui/ui 2>/dev/null || true)"

if [ -n "$cjs_hits" ]; then
  while IFS= read -r hit; do
    fail "CommonJS construct in an ESM package: $hit"
  done < <(printf '%s\n' "$cjs_hits")
fi

if [ "$failures" -ne 0 ]; then
  printf 'conventions: %d violation(s) found\n' "$failures" >&2
  exit 1
fi

printf 'conventions: all orchestrator conventions hold\n'
