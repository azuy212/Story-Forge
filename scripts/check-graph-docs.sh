#!/usr/bin/env bash
# Keeps the AGENTS.md pipeline section in sync with the graph definition.
#
# The node list is DERIVED from the addNode wiring in src/graph/index.ts (the
# only place nodes exist), then asserted against AGENTS.md: every node must
# be documented, and the documented spine order must match the wiring order.
# Renaming a node without updating the docs fails `pnpm lint`.
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
GRAPH_SRC="$ROOT_DIR/apps/orchestrator/src/graph/index.ts"
DOCS="$ROOT_DIR/AGENTS.md"

if [ ! -f "$GRAPH_SRC" ]; then
  echo "FAIL: graph source not found: $GRAPH_SRC" >&2
  exit 1
fi

if ! grep -q '```' "$DOCS"; then
  echo "FAIL: AGENTS.md has no fenced pipeline block" >&2
  exit 1
fi

failures=0

# Extract the documented pipeline block (the first fenced block after the
# "## Pipeline Overview" heading).
documented="$(python3 - "$DOCS" << 'PY'
import re
import sys

text = open(sys.argv[1]).read()
match = re.search(
    r"^## Pipeline Overview.*?```(?:[a-zA-Z0-9]*)\n(.*?)\n```",
    text,
    re.S | re.M,
)
if not match:
    sys.exit(1)
print(match.group(1))
PY
)"

if [ -z "$documented" ]; then
  echo "FAIL: could not read the pipeline block from AGENTS.md" >&2
  exit 1
fi

while IFS= read -r node; do
  [ -z "$node" ] && continue
  if ! printf '%s' "$documented" | grep -qw "$node"; then
    echo "FAIL: node '$node' is wired in src/graph/index.ts but missing from the AGENTS.md pipeline block" >&2
    failures=$((failures + 1))
  fi
done < <(python3 - "$GRAPH_SRC" << 'PY'
import re
import sys

source = open(sys.argv[1]).read()
nodes = []

for match in re.finditer(r"\.addNode\(\s*(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z_][A-Za-z0-9_]*))", source):
    literal = match.group(1) or match.group(2)
    if literal:
        nodes.append(literal)
        continue
    # A constant identifier: resolve it from its declaration in this file.
    name = match.group(3)
    const = re.search(
        rf"^(?:const|let)\s+{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]",
        source,
        re.M,
    )
    if const:
        nodes.append(const.group(1))

print("\n".join(nodes))
PY
)

# Order check: the documented spine must follow the wiring order.
if ! python3 - "$GRAPH_SRC" "$DOCS" << 'PY'
import re
import sys

source = open(sys.argv[1]).read()
docs = open(sys.argv[2]).read()

wired = []
for match in re.finditer(r"\.addNode\(\s*(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z_][A-Za-z0-9_]*))", source):
    literal = match.group(1) or match.group(2)
    if literal:
        wired.append(literal)
        continue
    name = match.group(3)
    const = re.search(
        rf"^(?:const|let)\s+{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]",
        source,
        re.M,
    )
    if const:
        wired.append(const.group(1))

block = re.search(
    r"^## Pipeline Overview.*?```(?:[a-zA-Z0-9]*)\n(.*?)\n```",
    docs,
    re.S | re.M,
)
if not block:
    sys.exit(1)
body = block.group(1)
positions = [body.find(node) for node in wired if body.find(node) >= 0]
missing = [node for node in wired if body.find(node) < 0]
if missing:
    print(f"missing: {', '.join(missing)}", file=sys.stderr)
    sys.exit(1)
if positions != sorted(positions):
    order = [node for node in wired if body.find(node) >= 0]
    print("documented order is " + " -> ".join(order), file=sys.stderr)
    sys.exit(2)
sys.exit(0)
PY
then
  echo "FAIL: AGENTS.md pipeline order does not match src/graph/index.ts" >&2
  failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
  echo "graph-docs: $failures problem(s) found" >&2
  exit 1
fi

echo "graph-docs: AGENTS.md pipeline matches src/graph/index.ts"
