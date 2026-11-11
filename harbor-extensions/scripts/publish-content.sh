#!/usr/bin/env bash
# Trusted platform Jenkins job only. Publishing updates the content bucket and nothing else: the running Deployment is
# never patched or restarted, because the app hot-reloads content from its read-only FUSE mount.
#
# Extension push (dev/prod branch): validate a candidate, then write ONLY extensions/<name>/ and connectors/<name>-*.yaml.
# Policy push (platform main, HARBOR_POLICY_ONLY=true): write ONLY config/grants.yaml and config/nav.yaml (plus the
# extensions/.keep and connectors/.keep placeholders when the bucket is new).
#
# Storage goes through scripts/storage/<adapter>.sh: "gcloud" (default, Jenkins) or "sim" (local kind simulation).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PYTHON=${HARBOR_PYTHON:-python}
FUSE_TTL=${HARBOR_FUSE_METADATA_TTL_SECONDS:-30}

for variable in HARBOR_BUCKET HARBOR_SOURCE_SHA HARBOR_SOURCE_REF HARBOR_SOURCE_EVENT; do
  [ -n "${!variable:-}" ] || { echo "Missing $variable" >&2; exit 2; }
done
[ "${HARBOR_CI:-}" = jenkins ] && [ "$HARBOR_SOURCE_EVENT" = push ] || { echo 'Platform Jenkins push job required' >&2; exit 2; }
if [ "${HARBOR_POLICY_ONLY:-}" = true ]; then
  [ -n "${HARBOR_POLICY_DIR:-}" ] || { echo 'Missing HARBOR_POLICY_DIR' >&2; exit 2; }
  [ "$HARBOR_SOURCE_REF" = refs/heads/main ] && [[ "${HARBOR_ENVIRONMENT:-}" =~ ^(dev|prod)$ ]] || { echo 'Policy publish requires a platform main push and target environment' >&2; exit 2; }
  environment=$HARBOR_ENVIRONMENT
else
  [ -n "${HARBOR_EXTENSION_CHECKOUT:-}" ] || { echo 'Missing HARBOR_EXTENSION_CHECKOUT' >&2; exit 2; }
  case "$HARBOR_SOURCE_REF" in
    refs/heads/dev) environment=dev ;;
    refs/heads/prod) environment=prod ;;
    *) echo 'Only dev and prod pushes can publish' >&2; exit 2 ;;
  esac
fi
[[ "$HARBOR_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 2; }
[[ "$HARBOR_BUCKET" =~ ^[a-z0-9][a-z0-9._-]+$ ]] || { echo 'Invalid bucket' >&2; exit 2; }
[[ "$FUSE_TTL" =~ ^[0-9]+$ ]] || { echo 'Invalid HARBOR_FUSE_METADATA_TTL_SECONDS' >&2; exit 2; }

adapter=${HARBOR_STORAGE_ADAPTER:-gcloud}
case "$adapter" in
  gcloud|sim) adapter="$ROOT/scripts/storage/$adapter.sh" ;;
  /*) [ -f "$adapter" ] || { echo "Storage adapter not found: $adapter" >&2; exit 2; } ;;
  *) echo 'Unknown storage adapter' >&2; exit 2 ;;
esac
# shellcheck source=/dev/null
. "$adapter"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Every bucket write goes through put/del, which refuse paths outside this publish's own namespace.
NAME=
allowed() {
  if [ "${HARBOR_POLICY_ONLY:-}" = true ]; then
    case "$1" in
      config/grants.yaml|config/nav.yaml|extensions/.keep|connectors/.keep) return 0 ;;
      *) return 1 ;;
    esac
  fi
  [ -n "$NAME" ] && [[ "$1" != *..* ]] || return 1
  case "$1" in
    extensions/"$NAME"/?*) return 0 ;;
    connectors/"$NAME"-?*.yaml) [[ "$1" != */*/* ]] ;;
    *) return 1 ;;
  esac
}
put() { allowed "$2" || { echo "Refusing to write outside this publish's namespace: $2" >&2; exit 1; }; st_put_file "$1" "$2"; }
del() { allowed "$1" || { echo "Refusing to delete outside this publish's namespace: $1" >&2; exit 1; }; st_delete "$1"; }
json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(typeof v==="string"?v:"")}catch{}})' "$1"; }

validate_candidate() {
  # Review-needed changes require protected-branch platform review before this trusted job is given bucket access.
  set +e
  (cd backend && "$PYTHON" -m harbor_platform.validate --root "$tmp/candidate" --base "$tmp/base" --ignore-base-errors)
  local validation=$?
  set -e
  if [ "$validation" -eq 2 ] && [ "${HARBOR_PLATFORM_REVIEW_ENFORCED:-}" = true ]; then
    echo 'Review-needed change accepted by the configured platform branch gate'
  elif [ "$validation" -ne 0 ]; then
    echo "Validation returned $validation; nothing was changed in the bucket" >&2
    exit 1
  fi
}

download_base() {
  mkdir -p "$tmp/base"
  for dir in extensions connectors config; do st_get_dir "$dir" "$tmp/base/$dir"; done
}

# ---- policy publish ------------------------------------------------------------------------------------------
if [ "${HARBOR_POLICY_ONLY:-}" = true ]; then
  download_base
  node scripts/compose-candidate.mjs "$tmp/base" - "$tmp/candidate" "$HARBOR_POLICY_DIR"
  validate_candidate
  : >"$tmp/empty"
  for dir in extensions connectors; do
    # A new bucket has no prefixes yet; FUSE and /readyz need both directories to exist.
    [ -n "$(ls -A "$tmp/base/$dir")" ] || put "$tmp/empty" "$dir/.keep"
  done
  for file in grants.yaml nav.yaml; do
    cmp -s "$HARBOR_POLICY_DIR/$file" "$tmp/base/config/$file" 2>/dev/null || put "$HARBOR_POLICY_DIR/$file" "config/$file"
  done
  for file in grants.yaml nav.yaml; do
    st_cat "config/$file" | cmp -s - "$HARBOR_POLICY_DIR/$file" || { echo "Read-back mismatch for config/$file" >&2; exit 1; }
  done
  echo "Published platform policy $HARBOR_SOURCE_SHA to $environment (bucket $HARBOR_BUCKET, config/); no Deployment change."
  echo "Visibility: running pods pick it up within ~${FUSE_TTL}s (FUSE metadata cache TTL)."
  exit 0
fi

# ---- extension publish ---------------------------------------------------------------------------------------
bundle="$tmp/bundle"
node scripts/gitops-bundle.mjs "$HARBOR_EXTENSION_CHECKOUT" "$environment" "$bundle" \
  || { echo 'Bundle rejected; nothing was changed in the bucket' >&2; exit 1; }
NAME=$(ls "$bundle/extensions")
[[ "$NAME" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]] && [ "$(ls "$bundle/extensions" | wc -l)" -eq 1 ] || { echo 'Bundle must contain exactly one extension' >&2; exit 1; }
marker_path="extensions/$NAME/.harbor-publish.json"

current=$(st_cat "$marker_path" 2>/dev/null | json_field commit || true)
if [ "$current" = "$HARBOR_SOURCE_SHA" ]; then
  echo "Already published: $NAME@$HARBOR_SOURCE_SHA is in bucket $HARBOR_BUCKET; nothing to do"
  exit 0
fi

download_base
[ -f "$tmp/base/config/grants.yaml" ] && [ -f "$tmp/base/config/nav.yaml" ] \
  || { echo 'Bucket is not bootstrapped: run the platform policy job for this environment first' >&2; exit 1; }
node scripts/compose-candidate.mjs "$tmp/base" "$bundle" "$tmp/candidate"
validate_candidate

src="$bundle/extensions/$NAME"
old="$tmp/base/extensions/$NAME"
# Write order keeps every intermediate state usable: assets first, then pages that reference them, then the manifest
# the registry reloads on, and only then remove files the new version no longer has.
upload() {
  local file rel
  while IFS= read -r -d '' file; do
    rel=${file#"$src/"}
    cmp -s "$file" "$old/$rel" 2>/dev/null || put "$file" "extensions/$NAME/$rel"
  done < <(find "$src" -type f "$@" -print0 | sort -z)
}
upload ! -name '*.html' ! -name '*.htm' ! -path "$src/extension.yaml"
upload \( -name '*.html' -o -name '*.htm' \)
for file in "$bundle"/connectors/"$NAME"-*.yaml; do
  [ -e "$file" ] || continue
  cmp -s "$file" "$tmp/base/connectors/$(basename "$file")" 2>/dev/null || put "$file" "connectors/$(basename "$file")"
done
put "$src/extension.yaml" "extensions/$NAME/extension.yaml"

while IFS= read -r object; do
  [ -n "$object" ] || continue
  rel=${object#extensions/"$NAME"/}
  [ "$rel" != .harbor-publish.json ] || continue
  [ -f "$src/$rel" ] || del "$object"
done < <(st_list "extensions/$NAME")
# Retire only connectors the previous publish of this extension recorded in its marker. Matching by "<name>-" prefix
# would let team-demo delete team-demo-extra's connector when the two are published concurrently.
while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$bundle/connectors/$file" ] || del "connectors/$file"
done < <(node --input-type=module -e '
  import { publishedConnectors } from "./scripts/publish-marker.mjs";
  for (const file of publishedConnectors(process.argv[1], process.argv[2])) console.log(file);
' "$old" "$NAME")

node -e '
  const [commit, ref, environment, dir] = process.argv.slice(1);
  const fs = require("fs");
  const connectors = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  process.stdout.write(JSON.stringify({ commit, ref, environment, connectors }) + "\n");
' "$HARBOR_SOURCE_SHA" "$HARBOR_SOURCE_REF" "$environment" "$bundle/connectors" >"$tmp/marker.json"
put "$tmp/marker.json" "$marker_path"
published=$(st_cat "$marker_path" | json_field commit)
[ "$published" = "$HARBOR_SOURCE_SHA" ] || { echo "Marker read-back mismatch: expected $HARBOR_SOURCE_SHA, found '${published:-none}'" >&2; exit 1; }
echo "Published $NAME $HARBOR_SOURCE_SHA to $environment (bucket $HARBOR_BUCKET); marker read back; no Deployment change."
echo "Visibility: running pods pick it up within ~${FUSE_TTL}s (FUSE metadata cache TTL)."
