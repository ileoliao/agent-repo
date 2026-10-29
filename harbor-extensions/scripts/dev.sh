#!/usr/bin/env bash
# Local start: mock systems (9001) + platform (8000, also serves the built portal)
# Usage: scripts/dev.sh        then open http://127.0.0.1:8000
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f portal/dist/index.html ]; then
  echo "Building the portal..."
  (cd portal && npm install --no-audit --no-fund && npm run build)
fi

cd backend
python -m uvicorn mocks.app:app --host 127.0.0.1 --port 9001 --log-level warning &
MOCKS=$!
trap 'kill $MOCKS 2>/dev/null' EXIT
echo "Mock systems: http://127.0.0.1:9001/docs"
echo "Portal:       http://127.0.0.1:8000${HARBOR_BASE_PATH:-}/"
python -m uvicorn harbor_platform.main:app --host 127.0.0.1 --port 8000
