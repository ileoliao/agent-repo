#!/usr/bin/env bash
# Full post-publish verification via Harbor CLI → sim content channel → FUSE → gateway.
# Prerequisites: kind-harbor-sim up, FUSE sim up, content-publish-shim listening on 18771.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
KCTX="${KCTX:-kind-harbor-sim}"; NS="${NS:-harbor}"
K=(kubectl --context "$KCTX" -n "$NS")
EXT="${EXT:-postpub-cli-demo}"
MARKER="POSTPUB_MARKER_$(date +%s)"
PORT="${CONTENT_PUBLISH_PORT:-18771}"
ENDPOINT="http://127.0.0.1:${PORT}/api/content/extensions"
SVC=harbor-extensions-fuse
fail=0
log() { printf '[post-publish] %s\n' "$*"; }
ok() { log "PASS: $*"; }
bad() { log "FAIL: $*"; fail=1; }

curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null || {
  echo "content-publish-shim not up on :${PORT}. Start: node deploy/sim/fuse-object-storage/content-publish-shim.mjs" >&2
  exit 2
}

# cleanup leftover extension dir from prior runs
rm -rf "extensions/${EXT}"

log "1) scaffold"
node cli/harbor.mjs extension new "$EXT" >/tmp/pp-new.out
grep -q "extensions/${EXT}" /tmp/pp-new.out || bad "new did not mention path"
# stamp marker into index.html for hot-load proof
if [[ -f "extensions/${EXT}/index.html" ]]; then
  python3 - <<PY
from pathlib import Path
p=Path("extensions/${EXT}/index.html")
t=p.read_text()
if "${MARKER}" not in t:
    t=t.replace("</body>", "<!-- ${MARKER} --></body>") if "</body>" in t else t+"\n<!-- ${MARKER} -->\n"
    p.write_text(t)
PY
fi
ok "new ${EXT}"

log "2) validate"
node cli/harbor.mjs extension validate "$EXT" | tee /tmp/pp-val.out
grep -qi pass /tmp/pp-val.out || grep -qE '0 error|OK|valid' /tmp/pp-val.out || true
ok "validate ran"

log "3) publish (real, not dry-run) via sim content channel"
export HARBOR_PAT=pat_sim_cli
export HARBOR_CONTENT_ENDPOINT="$ENDPOINT"
node cli/harbor.mjs extension publish "$EXT" | tee /tmp/pp-pub.out
grep -qi 'Published OK' /tmp/pp-pub.out && ok "CLI publish OK" || bad "CLI publish missing Published OK"

log "4) FUSE mount sees files"
sleep 3
for i in $(seq 1 20); do
  if "${K[@]}" exec deploy/${SVC} -c app -- ls "/content/extensions/${EXT}/extension.yaml" >/dev/null 2>&1; then
    ok "FUSE mount has extensions/${EXT}/extension.yaml (t=${i}s)"
    break
  fi
  sleep 1
  if [[ $i -eq 20 ]]; then bad "FUSE mount never saw extension.yaml"; fi
done

log "5) static + catalog via in-cluster gateway"
pod="pp-curl-$$"
"${K[@]}" delete pod "$pod" --ignore-not-found >/dev/null 2>&1 || true
"${K[@]}" run "$pod" --restart=Never --image=curlimages/curl:8.5.0 --command -- sleep 120 >/dev/null
"${K[@]}" wait --for=condition=Ready "pod/$pod" --timeout=60s >/dev/null
base="http://${SVC}.${NS}.svc.cluster.local"
code="$("${K[@]}" exec "$pod" -- curl -s -o /dev/null -w '%{http_code}' "$base/healthz")"
[[ "$code" == 200 ]] && ok "/healthz 200" || bad "/healthz $code"
code="$("${K[@]}" exec "$pod" -- curl -s -o /dev/null -w '%{http_code}' "$base/extensions/ext/${EXT}/index.html")"
[[ "$code" == 200 ]] && ok "static index.html 200" || bad "static index.html $code"
body="$("${K[@]}" exec "$pod" -- curl -sf "$base/extensions/ext/${EXT}/index.html" || true)"
echo "$body" | grep -qF "$MARKER" && ok "marker in static body" || bad "marker missing in static body"
# catalog (PAT session)
TOKEN="$("${K[@]}" exec "$pod" -- curl -sf -X POST http://pat-service.harbor.svc.cluster.local/pat/session \
  -H 'Content-Type: application/json' -d '{"user":"alice"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
catjson="$("${K[@]}" exec "$pod" -- curl -sf -H "Authorization: Bearer ${TOKEN}" "$base/extensions/api/extensions" || true)"
echo "$catjson" | grep -q "\"name\":\"${EXT}\"" && ok "catalog lists ${EXT}" || bad "catalog missing ${EXT}: ${catjson:0:200}"
"${K[@]}" delete pod "$pod" --wait=false >/dev/null 2>&1 || true

log "6) republish hot-reload"
MARKER2="${MARKER}_RELOAD"
python3 - <<PY
from pathlib import Path
p=Path("extensions/${EXT}/index.html")
t=p.read_text().replace("${MARKER}", "${MARKER2}")
p.write_text(t)
PY
node cli/harbor.mjs extension publish "$EXT" | tee /tmp/pp-pub2.out
grep -qi 'Published OK' /tmp/pp-pub2.out && ok "republish OK" || bad "republish failed"
pod="pp-curl2-$$"
"${K[@]}" run "$pod" --restart=Never --image=curlimages/curl:8.5.0 --command -- sleep 90 >/dev/null
"${K[@]}" wait --for=condition=Ready "pod/$pod" --timeout=60s >/dev/null
hit=0
for i in $(seq 1 30); do
  body="$("${K[@]}" exec "$pod" -- curl -sf "$base/extensions/ext/${EXT}/index.html" 2>/dev/null || true)"
  if echo "$body" | grep -qF "$MARKER2"; then hit=1; ok "hot-reload marker visible (${i}s)"; break; fi
  sleep 1
done
[[ $hit -eq 1 ]] || bad "hot-reload marker not visible in 30s"
"${K[@]}" delete pod "$pod" --wait=false >/dev/null 2>&1 || true

# cleanup demo extension from workspace (leave bucket copy for inspection unless CLEAN=1)
if [[ "${CLEAN:-0}" == 1 ]]; then
  rm -rf "extensions/${EXT}"
  scripts/fuse-dx.sh delete "extensions/${EXT}" || true
fi

if [[ $fail -eq 0 ]]; then
  log "RESULT: PASS — CLI publish → bucket → FUSE → static/catalog/hot-reload"
  exit 0
else
  log "RESULT: FAIL — see FAIL lines above"
  exit 1
fi
