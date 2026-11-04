#!/usr/bin/env bash
# Deprecated wrapper — prefer: harbor extension new <name>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/cli/harbor.mjs" extension new "$@"
