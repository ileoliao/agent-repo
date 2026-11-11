# Storage adapter for Jenkins: Google Cloud Storage through `gcloud storage`. Sourced by publish-content.sh.
# Paths are relative to the bucket root. Interface shared by every adapter:
#   st_get_dir  <prefix> <local-dir>   download everything under prefix (missing prefix => empty dir)
#   st_put_file <local-file> <path>    write one object
#   st_list     <prefix>               print object paths under prefix, one per line (missing => nothing)
#   st_delete   <path>                 delete one object
#   st_cat      <path>                 print one object (non-zero exit when missing)

_st_missing() { grep -q -E 'matched no objects|No URLs matched|404' <<<"$1"; }

st_get_dir() {
  local out
  mkdir -p "$2"
  if ! out=$(gcloud storage ls "gs://$HARBOR_BUCKET/$1/" 2>&1 </dev/null); then
    _st_missing "$out" && return 0
    echo "$out" >&2; return 1
  fi
  gcloud storage rsync "gs://$HARBOR_BUCKET/$1" "$2" --recursive --quiet </dev/null
}
st_put_file() { gcloud storage cp --quiet "$1" "gs://$HARBOR_BUCKET/$2" </dev/null; }
st_list() {
  local out
  if ! out=$(gcloud storage ls "gs://$HARBOR_BUCKET/$1/**" 2>&1 </dev/null); then
    _st_missing "$out" && return 0
    echo "$out" >&2; return 1
  fi
  sed -e "s#^gs://$HARBOR_BUCKET/##" <<<"$out" | grep -v -e '/$' -e ':$' || true
}
st_delete() { gcloud storage rm --quiet "gs://$HARBOR_BUCKET/$1" </dev/null; }
st_cat() { gcloud storage cat "gs://$HARBOR_BUCKET/$1" </dev/null; }
