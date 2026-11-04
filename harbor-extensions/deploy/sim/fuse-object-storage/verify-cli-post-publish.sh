#!/usr/bin/env bash
# Formal post-publish acceptance: Harbor CLI → in-cluster content-publish → FUSE → gateway.
# Prerequisites: kind-harbor-sim up, FUSE sim up (incl. content-publish Deployment).
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
HOST="${HOST:-harbor.sim.internal}"
# URL host must be harbor.sim.internal so Ingress matches; --resolve pins to loopback.
INGRESS_HTTPS="${INGRESS_HTTPS:-https://${HOST}:8443}"
CLEAN="${CLEAN:-1}"
fail=0
PF_PID=""
log() { printf '[post-publish] %s\n' "$*"; }
ok() { log "PASS: $*"; }
bad() { log "FAIL: $*"; fail=1; }

cleanup() {
  if [[ -n "${PF_PID}" ]] && kill -0 "$PF_PID" 2>/dev/null; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
  rm -f /tmp/pp-content-publish.pf.log
}
trap cleanup EXIT

log "0) ensure content-publish Ready"
if ! "${K[@]}" get deploy/content-publish >/dev/null 2>&1; then
  log "content-publish missing — applying manifests"
  "${K[@]}" apply -f deploy/sim/fuse-object-storage/content-publish.yaml
  kubectl --context "$KCTX" apply -f deploy/sim/fuse-object-storage/ingress-content-publish.yaml
fi
"${K[@]}" rollout status deploy/content-publish --timeout=180s
ok "content-publish Deployment Ready"

log "0b) port-forward svc/content-publish → 127.0.0.1:${PORT}"
# Drop any leftover host shim / prior pf on this port
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    log "stopping listener pid=$pid on :${PORT}"
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
fi
"${K[@]}" port-forward "svc/content-publish" "${PORT}:80" >/tmp/pp-content-publish.pf.log 2>&1 &
PF_PID=$!
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    ok "port-forward healthz (t=${i}s)"
    break
  fi
  sleep 0.5
  if [[ $i -eq 30 ]]; then
    bad "port-forward never healthy"; cat /tmp/pp-content-publish.pf.log || true
    exit 2
  fi
done

log "0c) Ingress /api/content routing smoke"
# Unauthenticated POST through ingress must be 401 (proves path → content-publish).
ing_code="$(curl -sk --resolve "${HOST}:8443:127.0.0.1" -o /tmp/pp-ing-body.txt -w '%{http_code}' \
  -X POST -H "Content-Type: application/json" -d '{}' \
  "${INGRESS_HTTPS}/api/content/extensions" || true)"
[[ "$ing_code" == "401" ]] && ok "ingress POST /api/content/extensions → 401 (unauth)" \
  || bad "ingress POST expected 401 got ${ing_code} body=$(head -c 200 /tmp/pp-ing-body.txt 2>/dev/null || true)"
ing_hz="$(curl -sk --resolve "${HOST}:8443:127.0.0.1" -o /tmp/pp-ing-hz.txt -w '%{http_code}' \
  "${INGRESS_HTTPS}/api/content/healthz" || true)"
[[ "$ing_hz" == "200" ]] && ok "ingress GET /api/content/healthz → 200" \
  || bad "ingress healthz expected 200 got ${ing_hz}"

# cleanup leftover extension dir from prior runs
rm -rf "extensions/${EXT}"

log "1) scaffold"
node cli/harbor.mjs extension new "$EXT" --owner post-publish-verify --contact verify@corp.test --description "Post-publish acceptance probe" >/tmp/pp-new.out
grep -q "extensions/${EXT}" /tmp/pp-new.out || bad "new did not mention path"
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
ok "validate ran"

log "3) publish (real) via in-cluster content-publish (port-forward)"
export HARBOR_PAT=pat_sim_cli
export HARBOR_CONTENT_ENDPOINT="$ENDPOINT"
# Prefer explicit content endpoint; HARBOR_URL also works once Ingress is used.
node cli/harbor.mjs extension publish "$EXT" | tee /tmp/pp-pub.out
grep -qi "Published '" /tmp/pp-pub.out && ok "CLI publish OK" || bad "CLI publish missing Published OK"

log "4) FUSE mount sees files"
sleep 2
for i in $(seq 1 25); do
  if "${K[@]}" exec deploy/${SVC} -c app -- ls "/content/extensions/${EXT}/extension.yaml" >/dev/null 2>&1; then
    ok "FUSE mount has extensions/${EXT}/extension.yaml (t=${i}s)"
    break
  fi
  sleep 1
  if [[ $i -eq 25 ]]; then bad "FUSE mount never saw extension.yaml"; fi
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
grep -qi "Published '" /tmp/pp-pub2.out && ok "republish OK" || bad "republish failed"
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

if [[ "$CLEAN" == 1 ]]; then
  log "cleanup local + bucket extensions/${EXT}"
  rm -rf "extensions/${EXT}"
  scripts/fuse-dx.sh delete "extensions/${EXT}" >/tmp/pp-clean.out 2>&1 || true
fi

if [[ $fail -eq 0 ]]; then
  log "RESULT: PASS — CLI publish → content-publish → bucket → FUSE → static/catalog/hot-reload"
  exit 0
else
  log "RESULT: FAIL — see FAIL lines above"
  exit 1
fi
