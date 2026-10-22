#!/usr/bin/env bash
# CI steps before a release: verify the list, build the ConfigMap, print the Helm checksum.
#   ./release.sh services.txt allowlist.regex [out-dir]
# Optional: OTELCOL=/path/to/otelcol-contrib also validates the expanded Collector config.
set -euo pipefail

SERVICES=${1:?services.txt}
REGEX=${2:?allowlist.regex}
OUT=${3:-out}
HERE=$(cd "$(dirname "$0")" && pwd)

python3 "$HERE/gen_allowlist.py" verify "$SERVICES" "$REGEX"

mkdir -p "$OUT"
kubectl create configmap otel-allowlist \
  --from-file=services.txt="$SERVICES" \
  --from-file=allowlist.regex="$REGEX" \
  --dry-run=client -o yaml > "$OUT/otel-allowlist.configmap.yaml"

if [[ -n "${OTELCOL:-}" ]]; then
  "$HERE/e2e/run.sh" "$SERVICES" "$REGEX" --validate-only
fi

SUM=$(sha256sum "$REGEX" | cut -d' ' -f1)
echo "ConfigMap: $OUT/otel-allowlist.configmap.yaml"
echo "Helm:      --set podAnnotations.checksum/allowlist=$SUM"
