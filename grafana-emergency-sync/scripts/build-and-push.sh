#!/usr/bin/env bash
set -euo pipefail
: "${SYNC_IMAGE:?Set SYNC_IMAGE (Artifact Registry image:tag)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker build --platform linux/amd64 -t "$SYNC_IMAGE" "$ROOT"
docker push "$SYNC_IMAGE"
