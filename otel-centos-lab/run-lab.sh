#!/usr/bin/env bash
# Smoke-test agent -> gateway on this box (no CentOS/Docker required).
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x ./bin/otelcol-contrib ]]; then
  echo "missing ./bin/otelcol-contrib (not part of this repo)." >&2
  echo "Download the otelcol-contrib release tarball for your OS/arch from" >&2
  echo "https://github.com/open-telemetry/opentelemetry-collector-releases/releases and extract the binary into ./bin/." >&2
  exit 1
fi
mkdir -p logs
# Stop only the collectors a previous run started (pid files), never other collectors on this machine.
for f in logs/gateway.pid logs/agent.pid; do
  if [[ -f "$f" ]]; then
    pid="$(cat "$f")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  fi
done
sleep 1
: > logs/gateway.log
: > logs/agent.log
rm -f logs/gateway-metrics.json
./bin/otelcol-contrib --config gateway-config.yaml > logs/gateway.log 2>&1 &
echo $! > logs/gateway.pid
sleep 2
./bin/otelcol-contrib --config agent-config.lab.yaml > logs/agent.log 2>&1 &
echo $! > logs/agent.pid
echo "running gateway=$(cat logs/gateway.pid) agent=$(cat logs/agent.pid); wait 45s..."
sleep 45
echo "=== metric names seen ==="
grep -oE 'Name: [a-zA-Z0-9._-]+' logs/gateway.log | sed 's/Name: //' | sort -u
echo "=== agent export counts ==="
grep 'info.*Metrics' logs/agent.log | tail -5
kill -TERM "$(cat logs/gateway.pid)" "$(cat logs/agent.pid)" 2>/dev/null || true
sleep 1
echo done
