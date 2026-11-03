#!/usr/bin/env bash
# FUSE sim developer loop: validate -> publish -> verify.
# Usage: scripts/fuse-dx.sh {validate|publish [relpath]|verify|dx|loop} 
# Tip: EXT=<name> selects the extension (publish/verify/dx).
# Env: KCTX (kind-harbor-sim) NS (harbor) BUCKET (harbor-content)
#      SVC (harbor-extensions-fuse) EXT (jira-glance)
#      PUBLISH_MARKER (string to poll for) MARKER_PATH (URL path, default index.html of EXT)
#      VERIFY_TIMEOUT (seconds, default 30)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
KCTX="${KCTX:-kind-harbor-sim}"; NS="${NS:-harbor}"; BUCKET="${BUCKET:-harbor-content}"
SVC="${SVC:-harbor-extensions-fuse}"; EXT="${EXT:-jira-glance}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-30}"
PODS=()
cleanup() { for p in "${PODS[@]:-}"; do [[ -n "$p" ]] && "${K[@]}" delete pod "$p" --wait=false >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
K=(kubectl --context "$KCTX" -n "$NS")
SIM_UP="./deploy/sim/fuse-object-storage/run-fuse-sim.sh up"
log() { printf '[fuse-dx] %s\n' "$*"; }
die() { printf '[fuse-dx] FAIL: %s\n' "$*" >&2; exit 1; }
now() { python3 -c 'import time;print(time.time())'; }

preflight() {
  command -v kubectl >/dev/null || die "kubectl not found; install it, then run: $SIM_UP"
  kubectl --context "$KCTX" get ns "$NS" >/dev/null 2>&1 || die "cluster '$KCTX' not reachable (or namespace '$NS' missing). Start the local sim with: $SIM_UP"
  "${K[@]}" get secret minio-fuse-creds >/dev/null 2>&1 || die "local sim content store not set up. Run: $SIM_UP"
  "${K[@]}" get deploy "$SVC" >/dev/null 2>&1 || die "sim deployment '$SVC' missing. Run: $SIM_UP"
}

cmd_validate() {
  log "validate: cd backend && python -m harbor_platform.validate"
  set +e; (cd "$REPO/backend" && python -m harbor_platform.validate); local rc=$?; set -e
  log "validate exit code: $rc (0=ok, 2=needs platform review, 1=errors)"
  [[ $rc -eq 1 ]] && die "validation errors; fix the messages above, then re-run: make validate"
  return 0
}

cmd_publish() {
  local rel="${1:-extensions/$EXT}"; rel="${rel#./}"; rel="${rel%/}"
  [[ "$rel" == extensions/*/* || "$rel" == extensions/* ]] && EXT="$(echo "$rel" | cut -d/ -f2)"
  case "$rel" in extensions/*) ;; *) die "path must be under extensions/ (got '$rel')";; esac
  local src="$REPO/$rel"
  [[ -e "$src" ]] || die "no such path: $src (create one with: make new EXT=<name>)"
  preflight
  local pod="fuse-dx-pub-$$"
  PODS+=("$pod")
  cat <<POD | "${K[@]}" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: {name: $pod, labels: {app.kubernetes.io/part-of: harbor-fuse-prototype}}
spec:
  restartPolicy: Never
  containers:
    - name: rclone
      image: harbor-fuse-rclone:sim
      imagePullPolicy: IfNotPresent
      command: [sleep, "120"]
      envFrom: [{secretRef: {name: minio-fuse-creds}}]
      volumeMounts: [{name: tmp, mountPath: /tmp}]
  volumes: [{name: tmp, emptyDir: {}}]
POD
  "${K[@]}" wait --for=condition=Ready "pod/$pod" --timeout=60s >/dev/null || die "uploader pod not ready"
  local dest="s3:$BUCKET/$rel" verb
  "${K[@]}" exec "$pod" -- mkdir -p "/tmp/up"
  if [[ -d "$src" ]]; then
    "${K[@]}" cp "$src/." "$pod:/tmp/up/"; verb=sync
  else
    "${K[@]}" cp "$src" "$pod:/tmp/up/$(basename "$src")"; verb=copyto
  fi
  local from="/tmp/up"; [[ -d "$src" ]] || from="/tmp/up/$(basename "$src")"
  log "publishing $rel -> s3://$BUCKET/$rel at $(date -u +%FT%TZ)"
  "${K[@]}" exec "$pod" -- sh -ec "
    export RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=Minio RCLONE_CONFIG_S3_ENV_AUTH=false
    export RCLONE_CONFIG_S3_ACCESS_KEY_ID=\"\$MINIO_ROOT_USER\" RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=\"\$MINIO_ROOT_PASSWORD\"
    export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.$NS.svc.cluster.local:9000 RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
    rclone $verb --checksum '$from' '$dest' -v 2>&1 | grep -E 'Copied|Updated|Deleted|Transferred' || true
    echo 'keys now in bucket:'; rclone ls '$dest' | head -50
  " || die "rclone upload failed"
  log "published OK: key prefix s3://$BUCKET/$rel"
}

cmd_delete() { # helper: delete one key (used for cleaning test markers)
  local rel="${1:?usage: delete extensions/<path>}"
  local pod="fuse-dx-del-$$"
  "${K[@]}" run "$pod" --restart=Never --image=harbor-fuse-rclone:sim --image-pull-policy=IfNotPresent \
    --overrides='{"spec":{"containers":[{"name":"'$pod'","image":"harbor-fuse-rclone:sim","imagePullPolicy":"IfNotPresent","command":["sleep","60"],"envFrom":[{"secretRef":{"name":"minio-fuse-creds"}}]}]}}' >/dev/null
  "${K[@]}" wait --for=condition=Ready "pod/$pod" --timeout=60s >/dev/null
  "${K[@]}" exec "$pod" -- sh -ec "
    export RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=Minio RCLONE_CONFIG_S3_ENV_AUTH=false
    export RCLONE_CONFIG_S3_ACCESS_KEY_ID=\"\$MINIO_ROOT_USER\" RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=\"\$MINIO_ROOT_PASSWORD\"
    export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.$NS.svc.cluster.local:9000 RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
    rclone purge 's3:$BUCKET/$rel' 2>/dev/null || rclone deletefile 's3:$BUCKET/$rel'"
  "${K[@]}" delete pod "$pod" --wait=false >/dev/null 2>&1 || true
  log "deleted s3://$BUCKET/$rel"
}

cmd_verify() {
  preflight
  local base="http://$SVC.$NS.svc.cluster.local"; base_url="$base"
  local idx="/extensions/ext/$EXT/index.html"
  local mpath="${MARKER_PATH:-$idx}" marker="${PUBLISH_MARKER:-}"
  local pod="fuse-dx-curl-$$"
  "${K[@]}" run "$pod" --restart=Never --image=curlimages/curl:8.5.0 --command -- sleep 120 >/dev/null
  PODS+=("$pod")
  "${K[@]}" wait --for=condition=Ready "pod/$pod" --timeout=60s >/dev/null || die "curl pod not ready"
  local fail=0 out
  for p in /healthz "$idx"; do
    out="$("${K[@]}" exec "$pod" -- curl -s -o /dev/null -w '%{http_code} %{time_total}' "$base$p")" || out="000 0"
    log "GET $p -> HTTP ${out% *} in ${out#* }s"
    [[ "${out%% *}" == 200 ]] || fail=1
  done
  if [[ -n "$marker" ]]; then
    local t0 hit=0 i; t0="$(now)"
    log "polling $mpath for marker '$marker' (up to ${VERIFY_TIMEOUT}s)"
    for ((i=0; i<VERIFY_TIMEOUT; i++)); do
      if "${K[@]}" exec "$pod" -- curl -sf "$base$mpath" | grep -qF -- "$marker"; then hit=1; break; fi
      sleep 1
    done
    if ((hit)); then log "marker visible after $(python3 -c "print(round($(now)-$t0,1))")s (hot-load OK)"
    else log "marker NOT seen at $mpath"; fail=1; fi
  fi
  if ((fail)); then
    log "hint: ${K[*]} logs deploy/$SVC -c rclone-mount --tail=50 ; check pod Ready and that path is published"
    die "verify FAILED"
  fi
  log "verify PASS"
  print_open
}

print_open() {
  cat <<OUT

  Your extension is live on the local sim:
    In-cluster URL : $base_url/extensions/ext/$EXT/index.html
    From your Mac  : kubectl --context $KCTX -n $NS port-forward svc/$SVC 8080:80
                     curl -i http://127.0.0.1:8080/extensions/ext/$EXT/index.html
OUT
}

cmd_dx() {
  local t0; t0="$(now)"
  cmd_validate
  cmd_publish "${1:-extensions/$EXT}"
  PUBLISH_MARKER="${PUBLISH_MARKER:-}" cmd_verify
  log "dx PASS total $(python3 -c "print(round($(now)-$t0,1))")s"
}

case "${1:-dx}" in
  validate) cmd_validate ;;
  publish) shift; cmd_publish "$@" ;;
  delete) shift; cmd_delete "$@" ;;
  verify) cmd_verify ;;
  unpublish) shift; cmd_delete "${1:-extensions/$EXT}" ;;
  dx|loop) shift || true; cmd_dx "$@" ;;
  *) echo "usage: $0 {validate|publish [relpath]|verify|dx|loop|unpublish [extensions/<name>]|delete <extensions/path>}" >&2; exit 2 ;;
esac
