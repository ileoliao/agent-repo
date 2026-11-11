#!/usr/bin/env bash
# Local GitHub-push analogue for bucket-only publishing. Push dev/prod to a bare remote, run the platform publish job
# (scripts/publish-content.sh with the sim storage adapter) against the simulated bucket, and prove the running pods
# pick the change up without any Deployment change, Pod replacement or container restart.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
NS=harbor
NAME=gitops-push-verify
HOST=harbor.sim.internal
BUCKET=harbor-content
PAT=pat_bob_all # simulated PAT service user in APP-DEV-ALL
PYTHON=${HARBOR_PYTHON:-$ROOT/.venv/bin/python}
TMP=$(mktemp -d)
POD=harbor-gitops-verify
K=(kubectl -n "$NS")
CURL=(curl -sk --resolve "$HOST:8443:127.0.0.1")
BASE_URL="https://$HOST:8443/extensions"

"$PYTHON" -c 'import sys; sys.path.insert(0, "backend"); import harbor_platform.validate' \
  || { echo "HARBOR_PYTHON=$PYTHON cannot import the platform validator (install backend/requirements.txt)" >&2; exit 2; }

cleanup() {
  if "${K[@]}" get pod "$POD" >/dev/null 2>&1; then
    "${K[@]}" exec "$POD" -- sh -ec '
      export RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=Minio RCLONE_CONFIG_S3_ENV_AUTH=false
      export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$MINIO_ROOT_USER" RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
      export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.harbor.svc.cluster.local:9000 RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
      rclone purge s3:harbor-content/extensions/gitops-push-verify
      rclone deletefile s3:harbor-content/connectors/gitops-push-verify-api.yaml
    ' >/dev/null 2>&1 || true
    "${K[@]}" delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Pod UIDs, per-container restart counts and the Deployment generation: any rollout or restart changes this string.
workload_state() {
  "${K[@]}" get deploy harbor-extensions -o jsonpath='gen={.metadata.generation} observed={.status.observedGeneration}{"\n"}'
  "${K[@]}" get pods -l app.kubernetes.io/name=harbor-extensions \
    -o jsonpath='{range .items[*]}{.metadata.name} {.metadata.uid}{range .status.containerStatuses[*]} {.name}={.restartCount}{end}{"\n"}{end}' | sort
}

git_commit() { git -C "$1" -c user.name=Harbor -c user.email=harbor@local.test commit -qam "$2"; }

publish() {
  local env=$1 checkout=$2
  HARBOR_CI=jenkins HARBOR_SOURCE_EVENT=push HARBOR_SOURCE_REF="refs/heads/$env" \
    HARBOR_SOURCE_SHA="$(git -C "$checkout" rev-parse HEAD)" HARBOR_EXTENSION_CHECKOUT="$checkout" \
    HARBOR_BUCKET="$BUCKET" HARBOR_STORAGE_ADAPTER=sim HARBOR_SIM_POD="$POD" HARBOR_SIM_NAMESPACE="$NS" \
    HARBOR_PYTHON="$PYTHON" HARBOR_PLATFORM_REVIEW_ENFORCED=true HARBOR_FUSE_METADATA_TTL_SECONDS=2 \
    bash scripts/publish-content.sh
}

# Wait until $1 (a command) succeeds; report how long the running pods took to serve the published change.
eventually() {
  local what=$1 started=$SECONDS
  shift
  for _ in $(seq 1 60); do
    if "$@"; then echo "  visible after $((SECONDS - started))s: $what"; return 0; fi
    sleep 1
  done
  echo "Timed out waiting for: $what" >&2
  return 1
}
page_has() { "${CURL[@]}" "$BASE_URL/ext/$NAME/index.html" | grep -q "$1"; }
status_is() { [ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE_URL/ext/$NAME/$1")" = "$2" ]; }
catalog_title_is() {
  "${CURL[@]}" -H "Authorization: Bearer $PAT" "$BASE_URL/api/extensions" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s).items.find(x=>x.name===process.argv[1]);process.exit(i&&i.title===process.argv[2]?0:1)})' "$NAME" "$1"
}

before=$(workload_state)
echo "Workload before publishing:"; sed 's/^/  /' <<<"$before"

git init --bare -q "$TMP/remote.git"
(cd "$TMP" && node "$ROOT/cli/harbor.mjs" extension new "$NAME" \
  --owner verification --contact verify@corp.test --description "GitOps push acceptance" >/dev/null)
git -C "$TMP/$NAME" init -q -b dev
git -C "$TMP/$NAME" add .
git_commit "$TMP/$NAME" initial
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
      command: [sleep, "900"]
      envFrom:
        - secretRef: {name: minio-fuse-creds}
POD
"${K[@]}" wait --for=condition=Ready "pod/$POD" --timeout=60s >/dev/null

publish dev "$TMP/dev-checkout"
eventually "v1 page" page_has "Gitops Push Verify"
eventually "v1 catalog entry" catalog_title_is "Gitops Push Verify"
status_is .harbor-publish.json 404 || { echo "Publish marker is served to browsers" >&2; exit 1; }
echo "PASS: dev push published v1 to the bucket and the running pods serve it"

sed -i.bak 's/^title: .*/title: "Gitops Push Verify v2"/' "$TMP/$NAME/extension.yaml" && rm "$TMP/$NAME/extension.yaml.bak"
printf '\n<!-- dev-v2-marker -->\n' >>"$TMP/$NAME/web/index.html"
printf 'console.log("v2 only");\n' >"$TMP/$NAME/web/v2-only.js"
git -C "$TMP/$NAME" add web/v2-only.js
git_commit "$TMP/$NAME" dev-v2
git -C "$TMP/$NAME" push -q origin dev
git -C "$TMP/dev-checkout" pull -q --ff-only origin dev
publish dev "$TMP/dev-checkout"
eventually "v2 page" page_has dev-v2-marker
eventually "v2 catalog title" catalog_title_is "Gitops Push Verify v2"
eventually "v2 asset" status_is v2-only.js 200
echo "PASS: later dev push hot-reloaded page, asset and manifest"

git -C "$TMP/$NAME" rm -q web/v2-only.js
git_commit "$TMP/$NAME" dev-v3
git -C "$TMP/$NAME" push -q origin dev
git -C "$TMP/dev-checkout" pull -q --ff-only origin dev
publish dev "$TMP/dev-checkout"
eventually "removed asset" status_is v2-only.js 404
publish dev "$TMP/dev-checkout" | grep -q 'Already published' || { echo "Re-running the same commit wrote to the bucket" >&2; exit 1; }
echo "PASS: removed file retired from the bucket; re-running the same commit is a no-op"

node scripts/gitops-bundle.mjs "$TMP/prod-checkout" prod "$TMP/prod-old" >/dev/null
if grep -q dev-v2-marker "$TMP/prod-old/extensions/$NAME/index.html"; then
  echo "Dev-only marker leaked into prod branch" >&2; exit 1
fi
git -C "$TMP/$NAME" switch -q prod
git -C "$TMP/$NAME" -c user.name=Harbor -c user.email=harbor@local.test merge -q --no-ff dev -m promote
git -C "$TMP/$NAME" push -q origin prod
git -C "$TMP/prod-checkout" pull -q --ff-only origin prod
node scripts/gitops-bundle.mjs "$TMP/prod-checkout" prod "$TMP/prod-promoted" >/dev/null
grep -q dev-v2-marker "$TMP/prod-promoted/extensions/$NAME/index.html"
grep -q "$NAME-api.prod.internal" "$TMP/prod-promoted/connectors/$NAME-api.yaml"
echo "PASS: prod branch stayed on v1 until promotion, then rendered its own upstream address"

after=$(workload_state)
if [ "$before" != "$after" ]; then
  echo "Workload changed during publishing:" >&2
  diff <(echo "$before") <(echo "$after") >&2 || true
  exit 1
fi
echo "PASS: Deployment generation, Pod UIDs and restart counts are unchanged; no Deployment was touched"
