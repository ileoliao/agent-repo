# FUSE object-storage content prototype (kind sim)

Local shape for “latest-only content from object storage via FUSE”, without replacing the default git-sync path.

## What this is

- **S3-compatible object store** in namespace `harbor` (SeaweedFS with S3 API; Service name `minio-fuse`) holding bucket `harbor-content`.
  MinIO container images could not be pulled in this environment (registry 401/denied), so SeaweedFS stands in with the same FUSE+S3 shape.
- A **demo Pod** (`content-fuse-demo`) that `rclone mount`s the bucket with `/dev/fuse`.
- An optional **`harbor-extensions-fuse` Deployment** (1 replica) that serves `HARBOR_ROOT=/content` from the same FUSE mount (no git-sync sidecar). The original `harbor-extensions` Deployment stays on git-sync.

## What this does / does not prove

| Proves (kind) | Does **not** prove (GKE) |
|---|---|
| App can read extension tree via a FUSE mount of object storage | GCS FUSE CSI Driver + Workload Identity |
| Updating an object in the bucket becomes visible through the mount (subject to rclone cache/poll settings) | GCS metadata consistency / CSI cache knobs |
| Privileged + `SYS_ADMIN` + `/dev/fuse` hostPath works on kind | Production PSP/PSA, GKE Autopilot constraints |
| Hot-reload against `HARBOR_ROOT` when wired | Production IAM, bucket versioning, multi-zone CSI |

True **GCS FUSE CSI does not speak MinIO**. This prototype only mirrors the *runtime shape*: “bucket holds latest tree → FUSE mount → app reads a directory”.

## Repeat

```bash
# From repo root (or this directory). Requires kind cluster harbor-sim already up.
./deploy/sim/fuse-object-storage/run-fuse-sim.sh
```

Tear down only the FUSE prototype (leaves git-sync sim intact):

```bash
./deploy/sim/fuse-object-storage/run-fuse-sim.sh destroy
```

## Cache / refresh notes

`rclone mount` uses short `--dir-cache-time` / `--attr-timeout` (S3 remotes do not support `--poll-interval`) so listings refresh within a few seconds after cache expiry. Directory listings can still lag until the next poll; force with remount or wait. `vfs-cache-mode off` avoids serving stale file bodies from a local VFS cache.

## Security note

The FUSE sidecar is **privileged** (needs `SYS_ADMIN` + `/dev/fuse`). Acceptable for kind demos only — not a production security model.


## Observed caveats (this run)

- Directory `mtime` under the mount often shows `Jan 1 2000` (S3/FUSE attribute quirk); do not rely on mtime for hot-reload signals — harbor-extensions still picked up content changes (catalog title updated after object overwrite).
- rclone logs: `poll-interval is not supported by this remote` for S3; refresh depends on `--dir-cache-time` / `--attr-timeout` expiry (set to 2s here). Update was visible on the first poll attempt (<~2s).
- FUSE sidecar is privileged (`SYS_ADMIN` + hostPath `/dev/fuse`) — kind-only.
- Images: `harbor-fuse-seaweedfs:sim`, `harbor-fuse-rclone:sim`, `harbor-fuse-busybox:sim` must be `kind load`ed (see `run-fuse-sim.sh` comments / load step).

## Mutate test

```bash
./deploy/sim/fuse-object-storage/run-fuse-sim.sh mutate "Jira Glance FUSE"
```

## Developer loop (shortest path)

> Community extension authors: use [docs/extension-developer.md](../../../docs/extension-developer.md) (`make new EXT=...`, `make try EXT=...`). The rest of this section is for operators.

Prerequisites: kind cluster `harbor-sim` is up (context `kind-harbor-sim`) and the FUSE sim is applied once
(`./deploy/sim/fuse-object-storage/run-fuse-sim.sh up`). Run from the repo root:

```bash
scripts/fuse-dx.sh validate                      # or: make validate
scripts/fuse-dx.sh publish extensions/jira-glance  # or: make fuse-publish P=extensions/<name>  (file or dir)
scripts/fuse-dx.sh verify                        # or: make fuse-verify
scripts/fuse-dx.sh dx                            # or: make fuse-dx   (validate -> publish -> verify)
```

- `validate` runs `python -m harbor_platform.validate` and prints the exit code (0 ok, 2 needs review, 1 errors; only 1 aborts).
- `publish` uploads the file/dir (must be under `extensions/`) to `s3://harbor-content/<same path>` through a short-lived rclone pod using Secret `minio-fuse-creds`, and logs the key and timestamp.
- `verify` curls `/healthz` and `/extensions/ext/jira-glance/index.html` on `harbor-extensions-fuse` from inside the cluster (expects 200, prints latency). To also wait for the change to hot-load:
  `PUBLISH_MARKER=<string> MARKER_PATH=/extensions/ext/jira-glance/<file> scripts/fuse-dx.sh verify` (timeout `VERIFY_TIMEOUT`, default 30s).
- `scripts/fuse-dx.sh delete extensions/<path>` removes a single object (e.g. a test marker). Note `publish` uses `sync` for directories, so files deleted locally are deleted in the bucket too.
- Overrides: `KCTX`, `NS`, `BUCKET`, `SVC`, `EXT`.

## TODO (out of scope here)

- Auth UI for the dev loop.
- Real GCS FUSE CSI driver on GKE.
- CI workflow that publishes to the bucket.

## Content-publish service (operators)

In-cluster FastAPI service that accepts the Harbor CLI publish body and syncs files into `s3://harbor-content/extensions/<name>/` (SeaweedFS via `minio-fuse` + Secret `minio-fuse-creds`).

- Manifests: `content-publish.yaml`, Ingress path in `ingress-content-publish.yaml` (`/api/content` → `content-publish:80`)
- Image: `harbor-content-publish:sim` (`Dockerfile.content-publish`); built and `kind load`ed by `run-fuse-sim.sh up`
- Auth (sim): `Authorization: Bearer <token>` required; token length ≥ 8 (convention: `pat_…`)
- Probes: `GET /healthz` (Service); also `GET /api/content/healthz` for Ingress smoke
- Host shim `content-publish-shim.mjs` is **DEPRECATED** (fallback only)

### How to verify

```bash
# After FUSE sim is up (content-publish Ready):
bash deploy/sim/fuse-object-storage/verify-cli-post-publish.sh
# Full log: tee /tmp/pp-formal-verify.log
```

CLI targeting the sim content channel (port-forward to the Service):

```bash
kubectl --context kind-harbor-sim -n harbor port-forward svc/content-publish 18771:80
export HARBOR_PAT=pat_sim_cli
export HARBOR_CONTENT_ENDPOINT=http://127.0.0.1:18771/api/content/extensions
# or via Ingress once /api/content is applied:
# export HARBOR_URL=https://harbor.sim.internal:8443
# (use curl --resolve / hosts entry for TLS Host)
node cli/harbor.mjs extension publish <name>
```

### Acceptance checklist (must pass)

- [ ] `content-publish` Deployment Ready; `GET /healthz` → `ok`
- [ ] Ingress: unauthenticated `POST /api/content/extensions` → **401**; `GET /api/content/healthz` → **200**
- [ ] `harbor extension new` → `validate` → real `publish` (not dry-run) → **Published OK**
- [ ] FUSE mount shows `extensions/<name>/extension.yaml`
- [ ] Gateway `/healthz` 200; static `/extensions/ext/<name>/index.html` 200 with published marker
- [ ] Catalog API lists `<name>`
- [ ] Republish updates static body (hot-reload within ~30s)
- [ ] Community criteria in [docs/post-publish-acceptance.md](../../../docs/post-publish-acceptance.md)

## Operator acceptance entry points

- `run-fuse-sim.sh up` — includes the in-cluster `content-publish` service and Ingress path `/api/content`
- `verify-cli-post-publish.sh` — CLI → content channel → gateway checks (default `CLEAN=1`)
- Developer-facing criteria: [docs/post-publish-acceptance.md](../../../docs/post-publish-acceptance.md)
- Sim caveat: `content-publish` accepts any Bearer token of length >= 8 (no real PAT introspection). A production content channel MUST introspect the PAT against the PAT service and authorize the publisher for the extension name.
