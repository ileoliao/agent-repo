#!/usr/bin/env bash
# Local GKE-style simulation of deploy/README.md on kind.
#   deploy/sim/run.sh up       build images, create kind cluster + ingress-nginx, create the Secret, kubectl apply -k, wait Ready
#   deploy/sim/run.sh verify   probes, ingress path prefix, auth, gateway, git-sync, audit, secret hygiene
#   deploy/sim/run.sh chaos    failure drills: PAT service down, content git down, new pod without content
#   deploy/sim/run.sh down     delete the cluster
# Needs: docker, kind, kubectl, curl, openssl. Host ports 8080/8443 are mapped to the cluster's ingress.
set -euo pipefail
cd "$(dirname "$0")/../.."          # harbor-extensions/
CLUSTER=harbor-sim
NS=harbor
HOST=harbor.sim.internal
ORIGIN="https://$HOST:8443"
CURL=(curl -sk --resolve "$HOST:8443:127.0.0.1" --max-time 15)
INGRESS_MANIFEST=https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml
EXTRA_IMAGES=(registry.k8s.io/git-sync/git-sync:v4.4.0 nginx:1.27-alpine)   # git-sync tag must match deploy/k8s/base/deployment.yaml
pass=0; fail=0

# `kind load docker-image` fails with docker's containerd image store ("content digest ... not found"); a single-platform archive works.
load_image() {
  local tar; tar=$(mktemp --suffix=.tar)
  docker save --platform linux/amd64 "$1" -o "$tar" && kind load image-archive "$tar" --name "$CLUSTER" >/dev/null
  rm -f "$tar"
}

up() {
  docker build -q -t harbor-extensions:sim . >/dev/null
  # The production .dockerignore (rightly) excludes backend/mocks, so the sim-only images use a staged context
  ctx=$(mktemp -d); trap 'rm -rf "$ctx"' RETURN
  mkdir -p "$ctx/backend" "$ctx/config"
  cp -r backend/mocks "$ctx/backend/mocks"; find "$ctx" -name __pycache__ -prune -exec rm -rf {} +
  cp -r connectors extensions "$ctx/"; cp config/grants.yaml config/nav.yaml "$ctx/config/"
  docker build -q -t harbor-sim-mocks:sim -f deploy/sim/Dockerfile.mocks "$ctx" >/dev/null
  docker build -q -t harbor-sim-content-git:sim -f deploy/sim/Dockerfile.content-git "$ctx" >/dev/null

  if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    kind create cluster --config deploy/sim/kind-cluster.yaml --wait 180s
  fi
  kubectl config use-context "kind-$CLUSTER" >/dev/null
  # Nodes may have no direct registry access (this VM's egress allows the host docker daemon only), so every image the
  # cluster needs is pulled by the host docker and side-loaded. On a networked machine this is simply a faster path.
  ing=$(mktemp); curl -sfL "$INGRESS_MANIFEST" | sed -E -e 's/@sha256:[0-9a-f]+//' -e '/hostPort:/d' > "$ing"
  for img in $(grep -oE 'image: \S+' "$ing" | awk '{print $2}' | sort -u) "${EXTRA_IMAGES[@]}"; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null
    load_image "$img"
  done
  for img in harbor-extensions:sim harbor-sim-mocks:sim harbor-sim-content-git:sim; do
    load_image "$img"
  done
  kubectl apply -f "$ing" >/dev/null; rm -f "$ing"
  kubectl -n ingress-nginx patch svc ingress-nginx-controller --type=json -p \
    '[{"op":"add","path":"/spec/ports/0/nodePort","value":30080},{"op":"add","path":"/spec/ports/1/nodePort","value":30443}]'
  kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=240s
  kubectl -n ingress-nginx wait --for=condition=Complete job/ingress-nginx-admission-patch --timeout=120s || true

  kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS"
  if ! kubectl -n "$NS" get secret harbor-extensions-secrets >/dev/null 2>&1; then
    # Sim values: the identity key is random per cluster; connector credentials must equal what the mocks expect.
    kubectl -n "$NS" create secret generic harbor-extensions-secrets \
      --from-literal=HARBOR_IDENTITY_KEY="$(openssl rand -hex 32)" \
      --from-literal=HARBOR_SECRET_JIRA_TOKEN=svc-jira-token \
      --from-literal=HARBOR_SECRET_SNOW_TOKEN=svc-snow-token \
      --from-literal=HARBOR_SECRET_HARBOR_RELEASE_TOKEN=svc-harbor-token
  fi

  # the ingress admission webhook can lag behind the controller's rollout; retry
  for i in 1 2 3 4 5 6; do kubectl apply -k deploy/sim/k8s && break || sleep 5; done
  kubectl apply -k deploy/k8s/overlays/sim
  for d in mocks content-git harbor-stub harbor-extensions; do
    kubectl -n "$NS" rollout status "deploy/$d" --timeout=240s
  done
  kubectl -n "$NS" get pods -o wide
}

ok()  { pass=$((pass+1)); echo "[PASS] $1"; }
bad() { fail=$((fail+1)); echo "[FAIL] $1  ${2:-}"; }
expect() { # name actual expected
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "(got '$2', want '$3')"; fi
}
code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }

verify() {
  kubectl config use-context "kind-$CLUSTER" >/dev/null
  echo "== cluster state"
  kubectl -n "$NS" get deploy,pods,svc,ingress,pdb
  ready=$(kubectl -n "$NS" get deploy harbor-extensions -o jsonpath='{.status.readyReplicas}')
  expect "Deployment harbor-extensions 2/2 ready" "$ready" 2
  expect "each app pod has 2 containers ready (app + git-sync)" \
    "$(kubectl -n $NS get pods -l app.kubernetes.io/name=harbor-extensions -o jsonpath='{range .items[*]}{.status.containerStatuses[*].ready}{"\n"}{end}' | sort -u)" "true true"

  echo "== probes via ClusterIP (kubectl port-forward), as the kubelet would"
  kubectl -n "$NS" port-forward svc/harbor-extensions 18080:80 >/dev/null 2>&1 &
  PF=$!; trap 'kill $PF 2>/dev/null' EXIT; sleep 2
  expect "/healthz 200" "$(curl -s -o /dev/null -w '%{http_code}' localhost:18080/healthz)" 200
  expect "/readyz 200 (content synced)" "$(curl -s localhost:18080/readyz)" '{"ok":true,"config_errors":0}'
  expect "ClusterIP: /extensions/api/health 200" "$(curl -s -o /dev/null -w '%{http_code}' localhost:18080/extensions/api/health)" 200
  expect "ClusterIP: root path not served (404)" "$(curl -s -o /dev/null -w '%{http_code}' localhost:18080/api/health)" 404

  echo "== through the ingress (path prefix /extensions, https, host $HOST)"
  expect "/ -> Harbor stub" "$("${CURL[@]}" https://$HOST:8443/ | grep -c 'Harbor (stub)')" 1
  expect "/extensions/api/health via ingress" "$(code https://$HOST:8443/extensions/api/health)" 200
  loc=$("${CURL[@]}" -D- -o /dev/null https://$HOST:8443/extensions | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
  expect "/extensions (no slash) redirects to /extensions/" "$loc" "/extensions/"
  expect "/healthz not routed to extensions (Harbor stub 404)" "$(code https://$HOST:8443/healthz)" 404
  expect "portal has <base href=/extensions/>" "$("${CURL[@]}" https://$HOST:8443/extensions/ | grep -c '<base href="/extensions/"')" 1
  pc=$("${CURL[@]}" https://$HOST:8443/extensions/api/portal-config)
  expect "dev_login is off in portal-config" "$(echo "$pc" | grep -c '"dev_login":false')" 1
  expect "dev-login endpoint disabled" "$(code -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"user":"alice"}' https://$HOST:8443/extensions/auth/dev-login)" 404
  expect "unauthenticated /api/me 401" "$(code https://$HOST:8443/extensions/api/me)" 401

  echo "== auth + gateway (PAT path and browser-session path), connectors reached in-cluster"
  B=https://$HOST:8443/extensions
  expect "PAT alice: /api/me 200" "$(code -H 'Authorization: Bearer pat_alice_cli' $B/api/me)" 200
  expect "PAT alice: jira search via gateway 200" "$(code -H 'Authorization: Bearer pat_alice_cli' "$B/gw/jira/rest/api/2/search?jql=project%20=%20PAY")" 200
  expect "PAT alice: jira comment denied by scope 403" "$(code -X POST -H 'Authorization: Bearer pat_alice_cli' -H 'Content-Type: application/json' -d '{"body":"x"}' $B/gw/jira/rest/api/2/issue/PAY-101/comment)" 403
  expect "PAT bob: jira comment 200/201" "$(code -X POST -H 'Authorization: Bearer pat_bob_all' -H 'Content-Type: application/json' -d '{"body":"x"}' $B/gw/jira/rest/api/2/issue/PAY-101/comment | cut -c1-2)" 20
  expect "bad PAT 401" "$(code -H 'Authorization: Bearer nope' $B/api/me)" 401
  expect "foreign Origin rejected 403" "$(code -H 'Authorization: Bearer pat_bob_all' -H 'Origin: https://evil.example' $B/api/me)" 403

  # Stand-in for Harbor's SSO: obtain a session from the PAT service, present it as the hx_session cookie
  sess() { kubectl -n $NS exec deploy/mocks -- python -c "import urllib.request,json,sys;r=urllib.request.Request('http://localhost:9001/pat/session',json.dumps({'user':sys.argv[1]}).encode(),{'Content-Type':'application/json'});print(json.load(urllib.request.urlopen(r))['token'])" "$1"; }
  A=$(sess alice); BOB=$(sess bob); PAM=$(sess pam)
  H=(-H "Origin: $ORIGIN")
  expect "session alice: outage list via gateway 200" "$(code "${H[@]}" -H 'X-Harbor-Extension: outage-console' -b "hx_session=$A" $B/gw/outage/api/outages)" 200
  expect "session without X-Harbor-Extension rejected" "$(code "${H[@]}" -b "hx_session=$A" $B/gw/outage/api/outages | cut -c1)" 4
  expect "session alice: extension catalog has 2 (git-sync content)" "$("${CURL[@]}" "${H[@]}" -b "hx_session=$A" $B/api/extensions | grep -o '"name":"[a-z-]*"' | sort -u | wc -l)" 2
  expect "extension file CSP sandbox" "$("${CURL[@]}" -D- -o /dev/null $B/ext/outage-console/index.html | grep -ic "content-security-policy: sandbox")" 1
  expect "secrets file not served" "$(code "$B/ext/outage-console/..%2f..%2fconfig%2fsecrets.dev.yaml")" 404
  r=$(code -X PATCH "${H[@]}" -H 'X-Harbor-Extension: release-calendar' -H 'Content-Type: application/json' -d '{"state":"scheduled"}' -b "hx_session=$BOB" $B/gw/snow/api/now/table/change_request/a1f0c2d4e5)
  expect "session bob: approve change via SNOW service account 200" "$r" 200
  actor=$("${CURL[@]}" "${H[@]}" -H 'X-Harbor-Extension: release-calendar' -b "hx_session=$BOB" $B/gw/snow/api/now/table/change_request/a1f0c2d4e5)
  expect "downstream SNOW recorded real actor bob (identity claim verified with Secret key)" "$(echo "$actor" | grep -c '"approved_by":"bob"')" 1
  expect "audit page: alice denied 403" "$(code "${H[@]}" -b "hx_session=$A" $B/api/audit)" 403
  expect "audit page: pam allowed 200" "$(code "${H[@]}" -b "hx_session=$PAM" $B/api/audit)" 200
  # deploy/README "Multiple replicas": sign-out revokes at the PAT service; other pods drop the token when their introspect cache expires (<= introspect_ttl = 60s)
  "${CURL[@]}" "${H[@]}" -b "hx_session=$A" -X POST -o /dev/null $B/auth/logout
  # the pod that served the logout forgets the token at once; the other keeps serving until its cache entry expires
  t0=$(date +%s); streak=0
  while [ $(( $(date +%s) - t0 )) -lt 80 ] && [ $streak -lt 10 ]; do
    if [ "$(code -b "hx_session=$A" $B/api/me)" = 401 ]; then streak=$((streak+1)); else streak=0; sleep 3; fi
  done
  took=$(( $(date +%s) - t0 ))
  expect "logout: 10 consecutive 401s across both replicas after ${took}s (limit: introspect_ttl 60s + margin)" "$([ $streak -ge 10 ] && [ $took -le 75 ] && echo yes || echo no)" yes

  echo "== k8s-specific"
  logs=$(kubectl -n $NS logs -l app.kubernetes.io/name=harbor-extensions -c app --tail=200 --prefix)
  expect "audit goes to stdout (harbor_audit lines)" "$([ "$(echo "$logs" | grep -c harbor_audit)" -gt 0 ] && echo yes || echo no)" yes
  expect "git-sync sidecar synced content" "$([ "$(kubectl -n $NS logs deploy/harbor-extensions -c git-sync --tail=50 | grep -ci 'updated successfully')" -gt 0 ] && echo yes || echo no)" yes
  expect "app container runs as uid 10001, read-only rootfs" "$(kubectl -n $NS exec deploy/harbor-extensions -c app -- sh -c 'id -u; touch /app/x 2>&1 | grep -c Read-only' | tr '\n' ' ')" "10001 1 "
  expect "secrets.dev.yaml absent in image and content" "$(kubectl -n $NS exec deploy/harbor-extensions -c app -- sh -c 'ls /app/config/secrets.dev.yaml /git/current/config/secrets.dev.yaml 2>&1 | grep -c "No such file"')" 2
  expect "HARBOR_IDENTITY_KEY comes from Secret, not dev default" "$(kubectl -n $NS exec deploy/harbor-extensions -c app -- printenv HARBOR_IDENTITY_KEY | grep -c 'dev-only')" 0

  echo "== content change without rollout: merge to the content repo, git-sync (30s period) hot-reloads"
  title() { "${CURL[@]}" "${H[@]}" -b "hx_session=$BOB" $B/api/extensions | grep -o '"title":"My Release Calendar[^"]*"' | head -1; }
  want() { for i in $(seq 1 24); do [ "$(title)" = "\"title\":\"$1\"" ] && return 0; sleep 5; done; return 1; }
  want "My Release Calendar" || bad "baseline title not reached"
  tag="synced $(date +%s)"
  kubectl -n $NS exec deploy/content-git -- sh -c "rm -rf /tmp/w && git clone -q /srv/git/content.git /tmp/w && cd /tmp/w && sed -i 's/^title: My Release Calendar.*/title: My Release Calendar ($tag)/' extensions/release-calendar/extension.yaml && git commit -qam retitle && git push -q origin HEAD:main"
  t0=$(date +%s); want "My Release Calendar ($tag)" && r=yes || r=no
  expect "extension retitled via git-sync in $(( $(date +%s) - t0 ))s, served by both replicas" "$r" yes
  expect "pods did not restart" "$(kubectl -n $NS get pods -l app.kubernetes.io/name=harbor-extensions -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.restartCount}{end}{end}')" "0000"
  kubectl -n $NS exec deploy/content-git -- sh -c 'cd /tmp/w && sed -i "s/^title: My Release Calendar.*/title: My Release Calendar/" extensions/release-calendar/extension.yaml && git commit -qam "restore title" && git push -q origin HEAD:main'

  echo; echo "$pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}

chaos() {  # failure drills from deploy/README ("introspect cache rides through PAT outages", content repo outage)
  kubectl config use-context "kind-$CLUSTER" >/dev/null
  B=https://$HOST:8443/extensions
  restarts() { kubectl -n $NS get pods -l app.kubernetes.io/name=harbor-extensions -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{end}'; }
  echo "== drill 1: PAT service down (scale mocks to 0)"
  for i in $(seq 1 12); do "${CURL[@]}" -o /dev/null -H 'Authorization: Bearer pat_bob_all' $B/api/me; done   # warm both replicas' caches (per-pod)
  kubectl -n $NS scale deploy/mocks --replicas=0 >/dev/null; sleep 5
  ok_all=yes; for i in $(seq 1 8); do [ "$(code -H 'Authorization: Bearer pat_bob_all' $B/api/me)" = 200 ] || ok_all=no; done
  expect "already-introspected token keeps working (cache rides through)" "$ok_all" yes
  expect "never-seen token gets 503 auth_unavailable (not 401)" "$(code -H "Authorization: Bearer pat_unseen_$RANDOM" $B/api/me)" 503
  expect "pods stay Ready (readiness ignores the PAT service)" "$(kubectl -n $NS get deploy harbor-extensions -o jsonpath='{.status.readyReplicas}')" 2
  kubectl -n $NS scale deploy/mocks --replicas=1 >/dev/null; kubectl -n $NS rollout status deploy/mocks --timeout=120s >/dev/null

  echo "== drill 2: content git server down (scale content-git to 0) for 100s"
  r0=$(restarts)
  kubectl -n $NS scale deploy/content-git --replicas=0 >/dev/null; sleep 100
  expect "service still answers 200 through ingress" "$(code -H 'Authorization: Bearer pat_bob_all' $B/api/me)" 200
  expect "both replicas still Ready (git-sync keeps retrying, no crash-loop)" "$(kubectl -n $NS get deploy harbor-extensions -o jsonpath='{.status.readyReplicas}')" 2
  expect "no container restarted" "$(restarts)" "$r0"
  kubectl -n $NS scale deploy/content-git --replicas=1 >/dev/null; kubectl -n $NS rollout status deploy/content-git --timeout=120s >/dev/null

  echo "== drill 3: a NEW pod while the content repo is down must not become Ready (never serve an empty catalog)"
  kubectl -n $NS scale deploy/content-git --replicas=0 >/dev/null; sleep 3
  kubectl -n $NS delete pod -l app.kubernetes.io/name=harbor-extensions --wait=false >/dev/null; sleep 45
  expect "replacement pods are NotReady (init git-sync cannot finish)" "$(kubectl -n $NS get pods -l app.kubernetes.io/name=harbor-extensions --field-selector=status.phase!=Failed -o jsonpath='{range .items[*]}{.status.containerStatuses[*].ready}{"\n"}{end}' | grep -c true)" 0
  kubectl -n $NS scale deploy/content-git --replicas=1 >/dev/null
  kubectl -n $NS rollout status deploy/harbor-extensions --timeout=240s >/dev/null
  expect "recovers by itself when the repo returns: 2/2 ready" "$(kubectl -n $NS get deploy harbor-extensions -o jsonpath='{.status.readyReplicas}')" 2
  echo; echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]
}

down() { kind delete cluster --name "$CLUSTER"; }

"${1:-up}"
