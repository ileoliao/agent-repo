#!/usr/bin/env bash
set -euo pipefail
# Secrets must exist before running this script (see README.md).
# Usage:
#   export GCP_ZONE_C=asia-east1-c
#   export GRAFANA_IMAGE=grafana/grafana:12.2.0
#   export SYNC_IMAGE=REGION-docker.pkg.dev/PROJECT/REPOSITORY/grafana-emergency-sync:v1
#   export SOURCE_GRAFANA_URL=https://grafana.mycompany.example
#   export EMERGENCY_GRAFANA_ROOT_URL=https://grafana-emergency.mycompany.example/
#   ./scripts/deploy.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for n in GCP_ZONE_C GRAFANA_IMAGE SYNC_IMAGE SOURCE_GRAFANA_URL EMERGENCY_GRAFANA_ROOT_URL; do
  if [ -z "${!n:-}" ]; then echo "Missing $n" >&2; exit 1; fi
done
kubectl create namespace monitoring-emergency --dry-run=client -o yaml | kubectl apply -f -
python3 - "$ROOT" <<'PY' | kubectl apply -f -
import os, pathlib, sys
root = pathlib.Path(sys.argv[1])
fields = ('GCP_ZONE_C', 'GRAFANA_IMAGE', 'SYNC_IMAGE', 'SOURCE_GRAFANA_URL', 'EMERGENCY_GRAFANA_ROOT_URL')
for path in (root / 'k8s/emergency.yaml', root / 'k8s/sync-cronjob.yaml'):
    content = path.read_text()
    for f in fields:
        content = content.replace('${' + f + '}', os.environ[f])
    if '${' in content:
        raise RuntimeError('Unresolved substitution in ' + str(path))
    print('---')
    print(content)
PY
