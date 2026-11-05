#!/usr/bin/env bash
set -euo pipefail
: "${EMERGENCY_ADMIN_PASSWORD:?Set EMERGENCY_ADMIN_PASSWORD}"
kubectl create namespace monitoring-emergency --dry-run=client -o yaml | kubectl apply -f -
printf 'username=%s\npassword=%s\n' "${EMERGENCY_ADMIN_USER:-admin}" "$EMERGENCY_ADMIN_PASSWORD" | \
  kubectl -n monitoring-emergency create secret generic emergency-grafana-admin \
  --from-env-file=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
