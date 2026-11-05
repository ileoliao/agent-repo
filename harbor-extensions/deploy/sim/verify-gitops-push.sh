#!/usr/bin/env bash
# Local GitHub-push analogue: push dev/prod to a bare remote, bundle checked-out branches, then sync to the sim bucket.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
NS=harbor
NAME=gitops-push-verify
HOST=harbor.sim.internal
TMP=$(mktemp -d)
POD=harbor-gitops-verify
K=(kubectl -n "$NS")

cleanup() {
  if "${K[@]}" get pod "$POD" >/dev/null 2>&1; then
    "${K[@]}" exec "$POD" -- sh -ec '
      export RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=Minio RCLONE_CONFIG_S3_ENV_AUTH=false
      export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$MINIO_ROOT_USER" RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
      export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.harbor.svc.cluster.local:9000 RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
      rclone purge s3:harbor-content/extensions/gitops-push-verify
      rclone deletefile s3:harbor-content/connectors/gitops-push-verify-api.yaml
    ' >/dev/null 2>&1 || true
    "${K[@]}" delete pod "$POD" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

git init --bare -q "$TMP/remote.git"
(
  cd "$TMP"
  node "$ROOT/cli/harbor.mjs" extension new "$NAME" \
    --owner verification --contact verify@corp.test --description "GitOps push acceptance" >/dev/null
)
git -C "$TMP/$NAME" init -q -b dev
git -C "$TMP/$NAME" add .
git -C "$TMP/$NAME" -c user.name=Harbor -c user.email=harbor@local.test commit -qm initial
git -C "$TMP/$NAME" branch prod
git -C "$TMP/$NAME" remote add origin "$TMP/remote.git"
git -C "$TMP/$NAME" push -q origin dev prod
git clone -q --branch dev "$TMP/remote.git" "$TMP/dev-checkout"
git clone -q --branch prod "$TMP/remote.git" "$TMP/prod-checkout"

"${K[@]}" delete pod "$POD" --ignore-not-found --wait=true >/dev/null

cat <<'POD' | "${K[@]}" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: harbor-gitops-verify
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
        - {name: bundle, mountPath: /bundle}
  volumes:
    - {name: bundle, emptyDir: {}}
POD
"${K[@]}" wait --for=condition=Ready "pod/$POD" --timeout=60s >/dev/null

sync_bundle() {
  local env=$1 checkout=$2 output=$3
  node scripts/gitops-bundle.mjs "$checkout" "$env" "$output"
  "${K[@]}" exec "$POD" -- sh -c 'rm -rf /bundle/*'
  "${K[@]}" cp "$output/." "$POD:/bundle/"
  "${K[@]}" exec "$POD" -- sh -ec '
    export RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=Minio RCLONE_CONFIG_S3_ENV_AUTH=false
    export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$MINIO_ROOT_USER" RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
    export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.harbor.svc.cluster.local:9000 RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
    rclone sync /bundle/extensions/gitops-push-verify/ s3:harbor-content/extensions/gitops-push-verify/
    rclone copy /bundle/connectors/gitops-push-verify-api.yaml s3:harbor-content/connectors/
  '
}

visible() {
  local marker=$1
  for attempt in $(seq 1 30); do
    if curl -sk --resolve "$HOST:8443:127.0.0.1" "https://$HOST:8443/extensions/ext/$NAME/index.html" | rg -q "$marker"; then
      return 0
    fi
    sleep 2
  done
  echo "Marker $marker did not appear in the FUSE-served extension" >&2
  return 1
}

sync_bundle dev "$TMP/dev-checkout" "$TMP/dev-v1"
visible "Gitops Push Verify"
echo "PASS: pushed dev branch reached the FUSE-served extension"

node -e 'const fs=require("fs"); const p=process.argv[1];fs.appendFileSync(p,"\n<!-- dev-v2-marker -->\n")' "$TMP/$NAME/web/index.html"
git -C "$TMP/$NAME" add web/index.html
git -C "$TMP/$NAME" -c user.name=Harbor -c user.email=harbor@local.test commit -qm dev-v2
git -C "$TMP/$NAME" push -q origin dev
git -C "$TMP/dev-checkout" pull -q --ff-only origin dev
node scripts/gitops-bundle.mjs "$TMP/prod-checkout" prod "$TMP/prod-old"
if rg -q dev-v2-marker "$TMP/prod-old/extensions/$NAME/index.html"; then
  echo "Dev-only marker leaked into prod branch" >&2; exit 1
fi
sync_bundle dev "$TMP/dev-checkout" "$TMP/dev-v2"
visible dev-v2-marker
echo "PASS: later dev push hot-reloaded; prod branch stayed on v1"

git -C "$TMP/$NAME" switch -q prod
git -C "$TMP/$NAME" -c user.name=Harbor -c user.email=harbor@local.test merge -q --no-ff dev -m promote
git -C "$TMP/$NAME" push -q origin prod
git -C "$TMP/prod-checkout" pull -q --ff-only origin prod
node scripts/gitops-bundle.mjs "$TMP/prod-checkout" prod "$TMP/prod-promoted"
rg -q dev-v2-marker "$TMP/prod-promoted/extensions/$NAME/index.html"
rg -q "$NAME-api.prod.internal" "$TMP/prod-promoted/connectors/$NAME-api.yaml"
echo "PASS: prod branch accepted the reviewed code with its own upstream address"
