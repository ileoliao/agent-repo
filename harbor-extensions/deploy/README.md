# Deploying on GKE behind Harbor

Harbor Extensions runs as its own service in the cluster. Harbor's existing ingress routes one path prefix to it;
Harbor's own code does not change. The only shared dependency is the PAT service.

```
https://<harbor-host>/            ──▶ Harbor (unchanged)
https://<harbor-host>/extensions/ ──▶ Service harbor-extensions ──▶ pods: app + git-sync sidecar
                                                                      │
                                                                      ├─ introspect ─▶ PAT service
                                                                      └─ /gw/... ─────▶ Jira / SNOW / Harbor Release / team services
```

## What is in the image, and what is not

| | Where | Changes via |
|---|---|---|
| Gateway, portal, SDK (`/app`) | Container image (`Dockerfile`) | Image build + rollout |
| Connectors, extensions, grants, nav (`HARBOR_ROOT`) | Content git repo, synced by the git-sync sidecar every 30 s | Merging a PR; no rollout |
| Runtime settings (`platform.yaml`) | ConfigMap, mounted at `HARBOR_CONFIG` | `kubectl apply` + restart |
| Signing key, connector credentials | k8s Secret `harbor-extensions-secrets` from Secret Manager | Secret rotation |

The image also carries a copy of the content in `/content`, so it runs on its own (staging, local `docker run`) without git-sync.
`config/secrets.dev.yaml` is never copied, and is ignored at runtime whenever `dev_login` is off.

## Steps

1. **Build**: `docker build -t REGION-docker.pkg.dev/PROJECT/harbor/harbor-extensions:<sha> .` from `harbor-extensions/`, push to Artifact Registry.
2. **Content repo**: put `connectors/`, `extensions/`, `config/grants.yaml`, `config/nav.yaml` at the root of a repo (or set git-sync's subpath and point `HARBOR_ROOT` at it). CI runs `python -m harbor_platform.validate` on PRs.
3. **Secret** `harbor-extensions-secrets`, keys:
   - `HARBOR_IDENTITY_KEY`: the service refuses to start without it when `dev_login` is off
   - `HARBOR_SECRET_<NAME>` for each `auth.secret` in the connectors (e.g. `HARBOR_SECRET_SNOW_TOKEN`)
4. **Overlay** per environment: image tag, `GITSYNC_REPO` (+ credentials), `pat_service_url`, `portal_origins` = Harbor's public origin.
5. **Apply**: `kubectl apply -k deploy/k8s/overlays/<env>`.
6. **Route** the prefix in Harbor's existing ingress, for example:

```yaml
# added to Harbor's Ingress (GCE or nginx); no prefix rewriting: the service already serves under /extensions
- path: /extensions
  pathType: Prefix
  backend:
    service: {name: harbor-extensions, port: {number: 80}}
```

`/healthz` and `/readyz` sit outside the prefix, so they are reachable by the kubelet but not through the ingress.
Readiness waits for the first git-sync; it deliberately ignores the PAT service, which the introspect cache rides through.

## Same host or own host

The service works either way (`base_path: /extensions`, or `base_path: ""` on its own hostname).

- **Same host as Harbor** (simplest; what the manifests assume): one origin and one certificate, and users see a single product.
  The trade-off is a shared browser origin: script running on any Harbor page could call `/extensions/...` with the user's
  session. Mitigated by the session cookie being scoped to `/extensions/` and distinctly named (`hx_session`), but an XSS
  in Harbor's UI would reach the gateway.
- **Own host** (e.g. `extensions.<harbor-domain>`): a separate origin, so neither UI can touch the other. Prefer this once
  the platform carries write capabilities to sensitive systems.

Extensions themselves are unaffected by this choice: they always run in an opaque-origin sandbox.

## Multiple replicas: what is per pod

| | Behaviour with N pods | Acceptable for the pilot? |
|---|---|---|
| Rate limiting | Per pod; effective limit is N × `rate_limit` (the ConfigMap halves it for 2 replicas) | Yes; move to Redis (Memorystore) if limits must be exact |
| Introspect cache | Per pod; each pod calls the PAT service at most once per token per TTL | Yes |
| Audit page in the portal | Shows only the pod that served the request | Use the log backend: audit lines are JSON on stdout under `harbor_audit` |
| Sign-out | Revokes at the PAT service; other pods drop the token when their cache entry expires (≤ `introspect_ttl`) | Yes, as long as the PAT service honours revocation |

## Not verified in the prototype environment

The Dockerfile and manifests were checked by running the same layout and settings outside a container, and the manifests
were schema-parsed, but the image has not been built and `kustomize build` has not been run here. Do both in CI first.
