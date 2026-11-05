#!/usr/bin/env bash
# Trusted platform Jenkins job only. Compose a complete release, upload it, then pin GKE.
set -euo pipefail
cd "$(dirname "$0")/.."

for variable in HARBOR_BUCKET HARBOR_NAMESPACE HARBOR_POLICY_DIR HARBOR_SOURCE_SHA HARBOR_SOURCE_REF HARBOR_SOURCE_EVENT; do
  [ -n "${!variable:-}" ] || { echo "Missing $variable" >&2; exit 2; }
done
[ "${HARBOR_CI:-}" = jenkins ] && [ "$HARBOR_SOURCE_EVENT" = push ] || { echo 'Platform Jenkins push job required' >&2; exit 2; }
if [ "${HARBOR_POLICY_ONLY:-}" = true ]; then
  [ "$HARBOR_SOURCE_REF" = refs/heads/main ] && [[ "${HARBOR_ENVIRONMENT:-}" =~ ^(dev|prod)$ ]] || { echo 'Policy release requires a platform main push and target environment' >&2; exit 2; }
  environment=$HARBOR_ENVIRONMENT
else
  [ -n "${HARBOR_EXTENSION_CHECKOUT:-}" ] || { echo 'Missing HARBOR_EXTENSION_CHECKOUT' >&2; exit 2; }
  case "$HARBOR_SOURCE_REF" in
    refs/heads/dev) environment=dev ;;
    refs/heads/prod) environment=prod ;;
    *) echo 'Only dev and prod pushes can deploy' >&2; exit 2 ;;
  esac
fi
[[ "$HARBOR_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 2; }
[[ "$HARBOR_BUCKET" =~ ^[a-z0-9][a-z0-9._-]+$ ]] || { echo 'Invalid bucket' >&2; exit 2; }
[[ "$HARBOR_NAMESPACE" =~ ^[a-z0-9-]+$ ]] || { echo 'Invalid namespace' >&2; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ "${HARBOR_POLICY_ONLY:-}" != true ]; then
  node scripts/gitops-bundle.mjs "$HARBOR_EXTENSION_CHECKOUT" "$environment" "$tmp/bundle"
fi

deployment=$(kubectl -n "$HARBOR_NAMESPACE" get deployment harbor-extensions -o json)
old=$(jq -r '.spec.template.spec.containers[] | select(.name=="app") | .env[] | select(.name=="HARBOR_RELEASE_ID") | .value' <<<"$deployment")
[[ "$old" =~ ^[a-f0-9]{40}$ ]] || { echo 'Deployment has no pinned release' >&2; exit 1; }
[ "$old" != "$HARBOR_SOURCE_SHA" ] || { echo 'This commit is already deployed' >&2; exit 1; }
bucket=$(jq -r '.spec.template.spec.volumes[] | select(.name=="content") | .csi.volumeAttributes.bucketName' <<<"$deployment")
[ "$bucket" = "$HARBOR_BUCKET" ] || { echo 'Deployment bucket differs from configured bucket' >&2; exit 1; }
gcloud storage rsync "gs://$HARBOR_BUCKET/releases/$old" "$tmp/base" --recursive
bundle="$tmp/bundle"
[ "${HARBOR_POLICY_ONLY:-}" != true ] || bundle=-
node scripts/compose-release.mjs "$tmp/base" "$bundle" "$tmp/release" "$HARBOR_SOURCE_SHA" "$HARBOR_POLICY_DIR"

# Review-needed changes require protected-branch platform review before this trusted job is given GCP identity.
set +e
(cd backend && python -m harbor_platform.validate --root "$tmp/release" --base "$tmp/base")
validation=$?
set -e
if [ "$validation" -eq 2 ] && [ "${HARBOR_PLATFORM_REVIEW_ENFORCED:-}" = true ]; then
  echo 'Review-needed change accepted by the configured platform branch gate'
elif [ "$validation" -ne 0 ]; then
  echo "Release validation returned $validation; no content or Deployment was changed" >&2
  exit 1
fi

# The new prefix is never served until the atomic Deployment patch below.
gcloud storage rsync "$tmp/release" "gs://$HARBOR_BUCKET/releases/$HARBOR_SOURCE_SHA" --recursive
gcloud storage objects describe "gs://$HARBOR_BUCKET/releases/$HARBOR_SOURCE_SHA/config/release.json" >/dev/null

root_index=$(jq -r '.spec.template.spec.containers | to_entries[] | select(.value.name=="app") | .key as $container | .value.env | to_entries[] | select(.value.name=="HARBOR_ROOT") | "\($container)/\(.key)"' <<<"$deployment")
release_index=$(jq -r '.spec.template.spec.containers | to_entries[] | select(.value.name=="app") | .key as $container | .value.env | to_entries[] | select(.value.name=="HARBOR_RELEASE_ID") | "\($container)/\(.key)"' <<<"$deployment")
[ -n "$root_index" ] && [ -n "$release_index" ] || { echo 'Deployment release env is incomplete' >&2; exit 1; }
patch=$(jq -nc --arg old "$old" --arg next "$HARBOR_SOURCE_SHA" --arg ri "$root_index" --arg li "$release_index" '[
  {op:"test",path:("/spec/template/spec/containers/"+$li+"/value"),value:$old},
  {op:"replace",path:("/spec/template/spec/containers/"+$ri+"/value"),value:("/content/releases/"+$next)},
  {op:"replace",path:("/spec/template/spec/containers/"+$li+"/value"),value:$next}
]')
kubectl -n "$HARBOR_NAMESPACE" patch deployment harbor-extensions --type=json -p "$patch"
if ! kubectl -n "$HARBOR_NAMESPACE" rollout status deployment/harbor-extensions --timeout=240s; then
  current=$(kubectl -n "$HARBOR_NAMESPACE" get deployment harbor-extensions -o json | jq -r '.spec.template.spec.containers[] | select(.name=="app") | .env[] | select(.name=="HARBOR_RELEASE_ID") | .value')
  if [ "$current" = "$HARBOR_SOURCE_SHA" ]; then kubectl -n "$HARBOR_NAMESPACE" rollout undo deployment/harbor-extensions; fi
  echo 'Rollout failed; previous release restored when this job still owned the Deployment' >&2
  exit 1
fi
echo "Deployed $environment $HARBOR_SOURCE_SHA to $HARBOR_NAMESPACE from gs://$HARBOR_BUCKET"
