#!/usr/bin/env bash
# Seed the local object store with the tracked sample content.
set -euo pipefail
cd "$(dirname "$0")/../../.." # agent-repo
NS=harbor
SEED=$(mktemp -d)
POD=harbor-content-seed
cleanup() {
  kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -rf "$SEED"
}
trap cleanup EXIT

git archive HEAD:harbor-extensions connectors extensions config/grants.yaml config/nav.yaml | tar -x -C "$SEED"
kubectl -n "$NS" delete pod "$POD" --ignore-not-found --wait=true >/dev/null
cat <<'POD' | kubectl -n "$NS" apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: harbor-content-seed
spec:
  restartPolicy: Never
  containers:
    - name: rclone
      image: harbor-fuse-rclone:sim
      imagePullPolicy: IfNotPresent
      command: [sleep, "300"]
      envFrom:
        - secretRef: {name: minio-fuse-creds}
      volumeMounts:
        - {name: seed, mountPath: /seed}
  volumes:
    - {name: seed, emptyDir: {}}
POD
kubectl -n "$NS" wait --for=condition=Ready "pod/$POD" --timeout=60s
kubectl -n "$NS" cp "$SEED/." "$POD:/seed/"
kubectl -n "$NS" exec "$POD" -- sh -ec '
  export RCLONE_CONFIG_S3_TYPE=s3
  export RCLONE_CONFIG_S3_PROVIDER=Minio
  export RCLONE_CONFIG_S3_ENV_AUTH=false
  export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$MINIO_ROOT_USER"
  export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
  export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.harbor.svc.cluster.local:9000
  export RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
  rclone mkdir s3:harbor-content
  rclone copy /seed/ s3:harbor-content/ --create-empty-src-dirs
'
echo "Seeded tracked sample content into harbor-content"
