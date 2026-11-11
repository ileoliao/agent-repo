# Storage adapter for the local kind simulation: rclone against the S3-compatible store, run inside a helper pod
# (image harbor-fuse-rclone:sim) through `kubectl exec`. The host needs no rclone. Same interface as gcloud.sh.
# Needs HARBOR_SIM_POD (a running pod with the minio-fuse-creds secret) and optionally HARBOR_SIM_NAMESPACE.
# HARBOR_BUCKET is the simulated bucket name (harbor-content).
# kubectl is used only to exec/cp into that helper pod; it never touches a Deployment.

: "${HARBOR_SIM_POD:?HARBOR_SIM_POD is required for the sim storage adapter}"
_st_ns=${HARBOR_SIM_NAMESPACE:-harbor}
_st_exec() {
  kubectl -n "$_st_ns" exec -i "$HARBOR_SIM_POD" -- sh -ec '
    export RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=Minio RCLONE_CONFIG_S3_ENV_AUTH=false
    export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$MINIO_ROOT_USER" RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
    export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.harbor.svc.cluster.local:9000 RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
    exec "$@"' sh "$@"
}

st_get_dir() {
  local rc=0
  mkdir -p "$2"
  _st_exec sh -c 'rm -rf /tmp/dl && mkdir -p /tmp/dl' </dev/null >/dev/null
  _st_exec rclone copy "s3:$HARBOR_BUCKET/$1" /tmp/dl </dev/null || rc=$?
  [ "$rc" -eq 0 ] || [ "$rc" -eq 3 ] || return "$rc" # 3 = directory not found: an empty prefix
  kubectl -n "$_st_ns" cp "$HARBOR_SIM_POD:/tmp/dl/." "$2" </dev/null >/dev/null
}
st_put_file() { _st_exec rclone rcat "s3:$HARBOR_BUCKET/$2" <"$1"; }
st_list() {
  _st_exec rclone lsf -R --files-only "s3:$HARBOR_BUCKET/$1" </dev/null 2>/dev/null | sed "s#^#$1/#" || true
}
st_delete() { _st_exec rclone deletefile "s3:$HARBOR_BUCKET/$1" </dev/null; }
st_cat() { _st_exec rclone cat "s3:$HARBOR_BUCKET/$1" </dev/null; }
