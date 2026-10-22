#!/usr/bin/env bash
# End-to-end check against an official otelcol-contrib binary.
#   OTELCOL=/path/to/otelcol-contrib ./run.sh services.txt allowlist.regex [--validate-only]
# 1. validate the config and confirm ${file:} expands to the bare regex
# 2. (unless --validate-only) run the Collector, send listed and unlisted services,
#    and check only the listed one reaches the exporter (all three signals)
set -euo pipefail

: "${OTELCOL:?set OTELCOL to an otelcol-contrib binary}"
SERVICES=${1:?services.txt}
REGEX=$(realpath "${2:?allowlist.regex}")
MODE=${3:-}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

sed "s#ALLOWLIST_FILE#$REGEX#g" "$HERE/collector.yaml" > "$WORK/config.yaml"
"$OTELCOL" validate --config="$WORK/config.yaml"
"$OTELCOL" print-config --config="$WORK/config.yaml" 2>/dev/null \
  | grep -qF "\"$(cat "$REGEX")\")" || { echo "FAIL: \${file:} did not expand to the bare regex"; exit 1; }
echo "OK: config valid, allowlist expands to the regex"
[[ "$MODE" == "--validate-only" ]] && exit 0

"$OTELCOL" --config="$WORK/config.yaml" > "$WORK/collector.log" 2>&1 &
PID=$!
for _ in $(seq 60); do grep -q 'Everything is ready' "$WORK/collector.log" && break; sleep 0.5; done

ALLOWED=$(grep -v '^\s*#' "$SERVICES" | sed 's/#.*//; s/[[:space:]]//g' | grep -m1 .)
python3 -I "$HERE/send.py" "$ALLOWED" > /dev/null
sleep 2

PASSED=$(grep -o 'service.name: Str([^)]*)' "$WORK/collector.log" | sort | uniq -c | sed 's/^ *//')
echo "Reached the exporter: ${PASSED:-nothing}"
[[ "$PASSED" == "3 service.name: Str($ALLOWED)" ]] || { echo "FAIL: expected only $ALLOWED, once per signal"; exit 1; }
! grep -q 'no-service-name' "$WORK/collector.log" || { echo "FAIL: data without service.name passed"; exit 1; }
curl -s 127.0.0.1:18888/metrics | grep '^otelcol_processor_filter_'
echo "OK: only $ALLOWED passed; near-misses, unlisted and unnamed data were dropped"
