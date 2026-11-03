#!/usr/bin/env bash
# Stand up MinIO + FUSE content mount prototype beside the existing kind sim (git-sync untouched).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NS=harbor
BUCKET=harbor-content
SEED_DIR="${SEED_DIR:-/tmp/harbor-content-seed}"
ACTION="${1:-up}"

need() { command -v "$1" >/dev/null || { echo "need $1" >&2; exit 1; }; }
need kubectl

log() { printf '[fuse-sim] %s\n' "$*"; }

ensure_images() {
  # Local tags expected by manifests; load into kind if present on the host.
  local imgs=(harbor-fuse-seaweedfs:sim harbor-fuse-rclone:sim harbor-fuse-busybox:sim)
  if ! command -v kind >/dev/null; then
    log "kind CLI not found; assuming images already on the node"
    return
  fi
  local missing=()
  for img in "${imgs[@]}"; do
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      missing+=("$img")
    fi
  done
  if ((${#missing[@]})); then
    log "missing host images: ${missing[*]}"
    log "build/tag them first, e.g. docker tag docker.m.daocloud.io/chrislusf/seaweedfs:4.46 harbor-fuse-seaweedfs:sim"
    log "and docker tag docker.m.daocloud.io/rclone/rclone:1.68 harbor-fuse-rclone:sim"
    exit 1
  fi
  kind load docker-image "${imgs[@]}" --name harbor-sim
}


seed_from_live_pod() {
  mkdir -p "$SEED_DIR"
  local pod
  pod="$(kubectl -n "$NS" get pod -l app.kubernetes.io/name=harbor-extensions -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "$pod" ]]; then
    log "no harbor-extensions pod; expecting SEED_DIR already populated at $SEED_DIR"
    [[ -d "$SEED_DIR/extensions" ]] || { echo "missing $SEED_DIR/extensions" >&2; exit 1; }
    return
  fi
  log "seeding tree from $pod:/git/current -> $SEED_DIR"
  rm -rf "$SEED_DIR"/config "$SEED_DIR"/connectors "$SEED_DIR"/extensions
  kubectl -n "$NS" cp -c app "$pod:/git/current/config" "$SEED_DIR/config"
  kubectl -n "$NS" cp -c app "$pod:/git/current/connectors" "$SEED_DIR/connectors"
  kubectl -n "$NS" cp -c app "$pod:/git/current/extensions" "$SEED_DIR/extensions"
}

upload_seed() {
  log "uploading $SEED_DIR to s3://$BUCKET via rclone (SeaweedFS S3)"
  kubectl -n "$NS" delete pod minio-fuse-seed-uploader --ignore-not-found >/dev/null 2>&1 || true

  cat <<'POD' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: minio-fuse-seed-uploader
  namespace: harbor
  labels:
    app.kubernetes.io/part-of: harbor-fuse-prototype
spec:
  restartPolicy: Never
  containers:
    - name: rclone
      image: harbor-fuse-rclone:sim
      imagePullPolicy: IfNotPresent
      command: [sleep, "600"]
      envFrom:
        - secretRef: {name: minio-fuse-creds}
      volumeMounts:
        - {name: seed, mountPath: /seed}
        - {name: tmp, mountPath: /tmp}
  volumes:
    - {name: seed, emptyDir: {}}
    - {name: tmp, emptyDir: {}}
POD

  kubectl -n "$NS" wait --for=condition=Ready pod/minio-fuse-seed-uploader --timeout=120s
  kubectl -n "$NS" cp "$SEED_DIR/." minio-fuse-seed-uploader:/seed/
  kubectl -n "$NS" exec minio-fuse-seed-uploader -- sh -ec '
    set -eux
    export RCLONE_CONFIG_S3_TYPE=s3
    export RCLONE_CONFIG_S3_PROVIDER=Minio
    export RCLONE_CONFIG_S3_ENV_AUTH=false
    export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$MINIO_ROOT_USER"
    export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
    export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.harbor.svc.cluster.local:9000
    export RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
    export RCLONE_CONFIG_S3_ACL=private
    rclone mkdir s3:harbor-content || true
    rclone sync /seed/ s3:harbor-content/ --create-empty-src-dirs
    rclone ls s3:harbor-content | head -50
    echo SEED_OK
  '
  kubectl -n "$NS" delete pod minio-fuse-seed-uploader --wait=false >/dev/null 2>&1 || true
}

destroy() {
  log "removing FUSE prototype resources (git-sync sim kept)"
  kubectl -n "$NS" delete deploy/harbor-extensions-fuse svc/harbor-extensions-fuse --ignore-not-found
  kubectl -n "$NS" delete pod content-fuse-demo --ignore-not-found
  kubectl -n "$NS" delete deploy/minio-fuse svc/minio-fuse pvc/minio-fuse-data secret/minio-fuse-creds --ignore-not-found
  kubectl -n "$NS" delete pod minio-fuse-seed-uploader --ignore-not-found
  kubectl -n "$NS" delete job minio-fuse-seed --ignore-not-found
  log "destroy done"
}

up() {
  ensure_images
  log "applying object store (SeaweedFS S3; Service minio-fuse)"
  kubectl apply -f "$ROOT/minio.yaml"
  kubectl -n "$NS" rollout status deploy/minio-fuse --timeout=180s

  seed_from_live_pod
  upload_seed

  log "applying FUSE demo pod"
  kubectl apply -f "$ROOT/fuse-demo.yaml"
  # Wait until reader can list /content/extensions
  for i in $(seq 1 60); do
    if kubectl -n "$NS" exec content-fuse-demo -c reader -- ls /content/extensions >/dev/null 2>&1; then
      log "FUSE demo mount ready (attempt $i)"
      break
    fi
    sleep 2
    if [[ "$i" -eq 60 ]]; then
      log "FUSE demo mount not ready; rclone logs:"
      kubectl -n "$NS" logs content-fuse-demo -c rclone-mount --tail=80 || true
      exit 1
    fi
  done
  kubectl -n "$NS" exec content-fuse-demo -c reader -- ls -la /content
  kubectl -n "$NS" exec content-fuse-demo -c reader -- ls /content/extensions

  log "applying harbor-extensions-fuse (optional path)"
  kubectl apply -f "$ROOT/harbor-extensions-fuse.yaml"
  kubectl -n "$NS" rollout status deploy/harbor-extensions-fuse --timeout=180s || {
    log "harbor-extensions-fuse rollout failed; describe/logs:"
    kubectl -n "$NS" describe deploy/harbor-extensions-fuse | tail -40 || true
    kubectl -n "$NS" logs deploy/harbor-extensions-fuse -c rclone-mount --tail=80 || true
    kubectl -n "$NS" logs deploy/harbor-extensions-fuse -c app --tail=80 || true
    exit 1
  }

  log "smoke: healthz + static extension via FUSE service"
  kubectl -n "$NS" delete pod fuse-smoke --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NS" run fuse-smoke --restart=Never --image=curlimages/curl:8.5.0 --command -- sleep 90
  kubectl -n "$NS" wait --for=condition=Ready pod/fuse-smoke --timeout=60s
  kubectl -n "$NS" exec fuse-smoke -- curl -sS -w '\nHTTP %{http_code}\n' http://harbor-extensions-fuse.harbor.svc.cluster.local/healthz
  kubectl -n "$NS" exec fuse-smoke -- curl -sS -w '\nHTTP %{http_code}\n' http://harbor-extensions-fuse.harbor.svc.cluster.local/readyz
  kubectl -n "$NS" exec fuse-smoke -- curl -sS -w '\nHTTP %{http_code}\n' http://harbor-extensions-fuse.harbor.svc.cluster.local/extensions/ext/jira-glance/index.html | head -c 300
  echo
  TOKEN="$(kubectl -n "$NS" exec fuse-smoke -- curl -sS -X POST http://pat-service.harbor.svc.cluster.local/pat/session -H 'Content-Type: application/json' -d '{"user":"alice"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  kubectl -n "$NS" exec fuse-smoke -- curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer ${TOKEN}" http://harbor-extensions-fuse.harbor.svc.cluster.local/extensions/api/extensions | head -c 1500
  echo
  kubectl -n "$NS" delete pod fuse-smoke --wait=false >/dev/null 2>&1 || true
  log "up complete — original harbor-extensions (git-sync) left running"
}

mutate_and_check() {
  local title="${1:-Jira Glance FUSE}"
  log "mutating extension.yaml title -> $title in object store"
  kubectl -n "$NS" delete pod minio-fuse-mutator --ignore-not-found >/dev/null 2>&1 || true
  cat <<'POD' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: minio-fuse-mutator
  namespace: harbor
  labels:
    app.kubernetes.io/part-of: harbor-fuse-prototype
spec:
  restartPolicy: Never
  containers:
    - name: rclone
      image: harbor-fuse-rclone:sim
      imagePullPolicy: IfNotPresent
      command: [sleep, "180"]
      envFrom:
        - secretRef: {name: minio-fuse-creds}
      volumeMounts:
        - {name: tmp, mountPath: /tmp}
  volumes:
    - {name: tmp, emptyDir: {}}
POD
  kubectl -n "$NS" wait --for=condition=Ready pod/minio-fuse-mutator --timeout=60s
  kubectl -n "$NS" exec minio-fuse-mutator -- sh -ec "
    set -eux
    export RCLONE_CONFIG_S3_TYPE=s3
    export RCLONE_CONFIG_S3_PROVIDER=Minio
    export RCLONE_CONFIG_S3_ENV_AUTH=false
    export RCLONE_CONFIG_S3_ACCESS_KEY_ID=\"\$MINIO_ROOT_USER\"
    export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=\"\$MINIO_ROOT_PASSWORD\"
    export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.harbor.svc.cluster.local:9000
    export RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
    export RCLONE_CONFIG_S3_ACL=private
    rclone copyto s3:harbor-content/extensions/jira-glance/extension.yaml /tmp/extension.yaml
    sed -i 's/^title:.*/title: ${title}/' /tmp/extension.yaml
    cat /tmp/extension.yaml
    rclone copyto /tmp/extension.yaml s3:harbor-content/extensions/jira-glance/extension.yaml
  "
log "waiting for FUSE demo reader to see new title (poll up to ~30s)"
  for i in $(seq 1 20); do
    got="$(kubectl -n "$NS" exec content-fuse-demo -c reader -- cat /content/extensions/jira-glance/extension.yaml 2>/dev/null || true)"
    if printf '%s' "$got" | grep -q "title: ${title}"; then
      log "demo mount saw update at attempt $i"
      printf '%s\n' "$got"
      break
    fi
    sleep 2
    if [[ "$i" -eq 20 ]]; then
      log "demo mount did not observe update; last content:"
      printf '%s\n' "$got"
      exit 1
    fi
  done
  log "checking harbor-extensions-fuse static + catalog (may need hot-reload)"
  sleep 3
  kubectl -n "$NS" delete pod fuse-smoke2 --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NS" run fuse-smoke2 --restart=Never --image=curlimages/curl:8.5.0 --command -- sleep 60
  kubectl -n "$NS" wait --for=condition=Ready pod/fuse-smoke2 --timeout=60s
  TOKEN="$(kubectl -n "$NS" exec fuse-smoke2 -- curl -sS -X POST http://pat-service.harbor.svc.cluster.local/pat/session -H 'Content-Type: application/json' -d '{"user":"alice"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  kubectl -n "$NS" exec fuse-smoke2 -- curl -sS -H "Authorization: Bearer ${TOKEN}" http://harbor-extensions-fuse.harbor.svc.cluster.local/extensions/api/extensions/jira-glance | head -c 1200
  echo
  kubectl -n "$NS" delete pod fuse-smoke2 minio-fuse-mutator --wait=false >/dev/null 2>&1 || true
}

case "$ACTION" in
  up) up ;;
  destroy|down) destroy ;;
  mutate) mutate_and_check "${2:-Jira Glance FUSE}" ;;
  seed) seed_from_live_pod; upload_seed ;;
  *) echo "usage: $0 [up|destroy|mutate [title]|seed]" >&2; exit 2 ;;
esac
