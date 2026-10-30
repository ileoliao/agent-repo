#!/usr/bin/env bash
# Smoke-test agent -> gateway on this box (no CentOS/Docker required).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
pkill -f 'otelcol-contrib --config' 2>/dev/null || true
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
