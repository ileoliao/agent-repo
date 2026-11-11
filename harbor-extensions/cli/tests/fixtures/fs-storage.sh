# Test-only storage adapter: a local directory stands in for the bucket and every write is logged in order.
: "${HARBOR_TEST_BUCKET_DIR:?HARBOR_TEST_BUCKET_DIR is required}"
_st_bucket=$HARBOR_TEST_BUCKET_DIR
_st_log() { [ -z "${HARBOR_TEST_STORAGE_LOG:-}" ] || printf '%s\n' "$*" >>"$HARBOR_TEST_STORAGE_LOG"; }
st_get_dir() { mkdir -p "$2"; [ ! -d "$_st_bucket/$1" ] || cp -R "$_st_bucket/$1/." "$2/"; }
st_put_file() { mkdir -p "$(dirname "$_st_bucket/$2")"; cp "$1" "$_st_bucket/$2"; _st_log "put $2"; }
st_list() { [ -d "$_st_bucket/$1" ] || return 0; (cd "$_st_bucket" && find "$1" -type f | sort); }
st_delete() { rm -f "$_st_bucket/$1"; _st_log "del $1"; }
st_cat() { cat "$_st_bucket/$1"; }
