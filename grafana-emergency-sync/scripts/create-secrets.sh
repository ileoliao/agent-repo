#!/usr/bin/env bash
set -euo pipefail
# Credentials are read from environment, not passed on command-line or written to disk.
# Required: EMERGENCY_ADMIN_PASSWORD, PRIMARY_GRAFANA_TOKEN, EMERGENCY_GRAFANA_TOKEN
# Optional: EMERGENCY_ADMIN_USER (default admin), DATASOURCE_SECRETS_JSON_FILE (JSON object)
: "${EMERGENCY_ADMIN_PASSWORD:?Set EMERGENCY_ADMIN_PASSWORD}"
: "${PRIMARY_GRAFANA_TOKEN:?Set PRIMARY_GRAFANA_TOKEN}"
: "${EMERGENCY_GRAFANA_TOKEN:?Set EMERGENCY_GRAFANA_TOKEN}"
kubectl create namespace monitoring-emergency --dry-run=client -o yaml | kubectl apply -f -
printf 'username=%s\npassword=%s\n' "${EMERGENCY_ADMIN_USER:-admin}" "$EMERGENCY_ADMIN_PASSWORD" | \
  kubectl -n monitoring-emergency create secret generic emergency-grafana-admin \
  --from-env-file=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
printf 'source_token=%s\ntarget_token=%s\n' "$PRIMARY_GRAFANA_TOKEN" "$EMERGENCY_GRAFANA_TOKEN" | \
  kubectl -n monitoring-emergency create secret generic grafana-sync-tokens \
  --from-env-file=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
if [ -n "${DATASOURCE_SECRETS_JSON_FILE:-}" ]; then
  FILE="$DATASOURCE_SECRETS_JSON_FILE"
else
  FILE=$(mktemp)
  trap 'rm -f "$FILE"' EXIT
  printf '{}\n' > "$FILE"
fi
kubectl -n monitoring-emergency create secret generic grafana-sync-datasource-secrets \
  --from-file=datasources.json="$FILE" \
  --dry-run=client -o yaml | kubectl apply -f -
