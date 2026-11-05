#!/usr/bin/env bash
# Local kind simulation: one app Deployment, object storage, and a FUSE content mount.
set -euo pipefail
cd "$(dirname "$0")/../.." # harbor-extensions
CLUSTER=harbor-sim
NS=harbor
HOST=harbor.sim.internal
INGRESS_MANIFEST=https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml

load_images() {
  local images=(harbor-extensions:sim harbor-sim-mocks:sim
    harbor-fuse-seaweedfs:sim harbor-fuse-rclone:sim)
  local img
  for img in "${images[@]}"; do
    docker image inspect "$img" >/dev/null || { echo "Missing local image: $img" >&2; exit 1; }
  done
  local archive
  archive=$(mktemp -t harbor-image)
  docker save "${images[@]}" -o "$archive"
  kind load image-archive "$archive" --name "$CLUSTER"
  rm -f "$archive"
}

up() {
  docker build -q -t harbor-extensions:sim . >/dev/null
  local ctx
  ctx=$(mktemp -d)
  mkdir -p "$ctx/backend"
  cp -R backend/mocks "$ctx/backend/mocks"
  find "$ctx" -name __pycache__ -prune -exec rm -rf {} +
  docker build -q -t harbor-sim-mocks:sim -f deploy/sim/Dockerfile.mocks "$ctx" >/dev/null
  rm -rf "$ctx"

  if ! kind get clusters | grep -qx "$CLUSTER"; then
    kind create cluster --config deploy/sim/kind-cluster.yaml --wait 180s
  fi
  kubectl config use-context "kind-$CLUSTER" >/dev/null
  load_images

  local ingress
  ingress=$(mktemp)
  curl -sfL "$INGRESS_MANIFEST" | sed -E -e 's/@sha256:[0-9a-f]+//' -e '/hostPort:/d' > "$ingress"
  local img archive
  for img in $(grep -oE 'image: \S+' "$ingress" | awk '{print $2}' | sort -u); do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null
    archive=$(mktemp -t harbor-image)
    docker save "$img" -o "$archive"
    kind load image-archive "$archive" --name "$CLUSTER" >/dev/null
    rm -f "$archive"
  done
  kubectl apply -f "$ingress" >/dev/null
  rm -f "$ingress"
  kubectl -n ingress-nginx patch svc ingress-nginx-controller --type=json -p \
    '[{"op":"add","path":"/spec/ports/0/nodePort","value":30080},{"op":"add","path":"/spec/ports/1/nodePort","value":30443}]' >/dev/null
  kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=240s

  kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS" >/dev/null
  if ! kubectl -n "$NS" get secret harbor-extensions-secrets >/dev/null 2>&1; then
    kubectl -n "$NS" create secret generic harbor-extensions-secrets \
      --from-literal=HARBOR_IDENTITY_KEY="$(openssl rand -hex 32)" \
      --from-literal=HARBOR_SECRET_JIRA_TOKEN=svc-jira-token \
      --from-literal=HARBOR_SECRET_SNOW_TOKEN=svc-snow-token \
      --from-literal=HARBOR_SECRET_HARBOR_RELEASE_TOKEN=svc-harbor-token >/dev/null
  fi
  kubectl apply -k deploy/sim/k8s >/dev/null
  kubectl -n "$NS" rollout status deploy/mocks --timeout=180s
  local applied=false
  for attempt in 1 2 3 4 5; do
    if kubectl apply -k deploy/k8s/overlays/sim >/dev/null; then applied=true; break; fi
    sleep 5
  done
  [ "$applied" = true ] || { echo "Failed to apply the sim overlay" >&2; exit 1; }
  kubectl -n "$NS" rollout status deploy/minio-fuse --timeout=180s
  bash deploy/sim/seed-content.sh
  kubectl -n "$NS" rollout status deploy/harbor-extensions --timeout=240s

  # Retire the former direct upload service from reused simulation clusters.
  kubectl -n "$NS" delete deploy/content-publish svc/content-publish --ignore-not-found >/dev/null
  kubectl -n "$NS" get deploy harbor-extensions minio-fuse
}

verify() {
  kubectl config use-context "kind-$CLUSTER" >/dev/null
  kubectl -n "$NS" rollout status deploy/harbor-extensions --timeout=60s
  local code
  code=$(curl -sk --resolve "$HOST:8443:127.0.0.1" -o /dev/null -w '%{http_code}' \
    "https://$HOST:8443/extensions/api/health")
  [ "$code" = 200 ] || { echo "Extensions health returned $code" >&2; exit 1; }
  code=$(curl -sk --resolve "$HOST:8443:127.0.0.1" -o /dev/null -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' -d '{}' "https://$HOST:8443/api/content/extensions")
  [ "$code" = 404 ] || { echo "Retired content API returned $code (expected 404)" >&2; exit 1; }
  deploy/sim/verify-gitops-push.sh
}

case "${1:-up}" in
  up) up ;;
  verify) verify ;;
  down) kind delete cluster --name "$CLUSTER" ;;
  *) echo "usage: $0 [up|verify|down]" >&2; exit 2 ;;
esac
