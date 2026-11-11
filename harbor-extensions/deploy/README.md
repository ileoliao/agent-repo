# Deploying Harbor Extensions

For the environment parameter checklist, bucket initialization, Jenkins setup and acceptance steps, use the [internal rollout runbook](../docs/internal-rollout.md).

Harbor routes `/extensions` to the `harbor-extensions` Service. The app image contains the gateway, Portal and SDK. A read-only content mount at `/content` supplies connectors, extensions, grants and navigation config. In GKE that mount is the environment bucket's root. Publishing rewrites bucket objects only and the app hot-reloads them; the Deployment changes only for platform image or manifest upgrades. The app does not write content.

## GKE base

`deploy/k8s/base` defines two app replicas, a Service, ConfigMap, ServiceAccount and PodDisruptionBudget. The Deployment uses the [Cloud Storage FUSE CSI driver](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/cloud-storage-fuse-csi-driver-ephemeral) with the required `gke-gcsfuse/volumes: "true"` Pod annotation. There is one content source and no in-Pod git client.

Before applying an environment overlay:

1. Set the environment overlay's Cloud Storage bucket. Initialize it with the platform policy job so its root contains `connectors/`, `extensions/`, `config/grants.yaml` and `config/nav.yaml`.
2. Grant the `harbor-extensions` Kubernetes ServiceAccount read access to that bucket using the environment's Workload Identity setup.
3. Pin the image digest and set the PAT service URL, portal origin, Harbor login URL and ingress proxy CIDRs. Provide `harbor-extensions-secrets` with `HARBOR_IDENTITY_KEY` and connector credentials.
4. Give only the platform Jenkins publish agent write access to the environment bucket. It needs no GKE permission. The `dev` and `prod` jobs use different identities and buckets. Extension authors receive no bucket credentials and there is no content upload API.
5. Route `/extensions` through Harbor's ingress to `harbor-extensions:80`. The health probes stay at `/healthz` and `/readyz` on the Service.

The `dev` and `prod` overlays are templates with deliberately unresolved values. Populate their bucket, immutable image digest, PAT URL, Harbor origin, login URL and trusted ingress proxy CIDRs. `node scripts/check-gke-manifest.mjs dev` (or `prod`) refuses placeholders, a mutable image, a content root other than the bucket root, and a FUSE mount without `metadata-cache:ttl-secs` between 0 and 60. The base sets 30 seconds, which bounds how long a Pod may serve the previous version after a publish. The image's baked `/content` copy remains useful for local `docker run`; the mounted bucket replaces it in GKE.

The platform-owned `jenkins/Jenkinsfile.deploy` is loaded by a trusted Jenkins Pipeline job from this repository. Register one extension job per repository with a fixed Git URL and repository slug, and a separate platform-policy job for `main`. The GitHub webhook supplies event, repository, ref and SHA; the job rejects anything except a registered push, checks out that branch, and verifies the checkout SHA before running the publish script. Configure webhook HMAC verification, a dedicated job trigger, restricted build permissions and CODEOWNERS branch protection. Do not load a privileged Jenkinsfile from an extension repository: an author could edit it to use bucket credentials. Jenkins agents need Node 22, Python 3.12 and `gcloud`, plus GCP workload identity or another platform-managed short-lived credential. Job-owned `HARBOR_DEV_BUCKET` and `HARBOR_PROD_BUCKET` settings name the buckets; extension authors cannot set them. Configure separate identities and least-privilege IAM/RBAC per environment. The `jenkins/Jenkinsfile.verify` job runs platform tests without deployment credentials.

The job uses `scripts/publish-content.sh`, which reaches storage only through `scripts/storage/gcloud.sh` (`sim.sh` in the kind simulation):

1. Bundle the pushed commit. Skip if `extensions/<name>/.harbor-publish.json` already records that commit.
2. Download the current bucket content, apply this one extension in a local candidate (`scripts/compose-candidate.mjs`), and run platform validation against it. The candidate is never uploaded.
3. Write only changed files under `extensions/<name>/`: assets first, then HTML, then the `connectors/<name>-*.yaml` files, then `extension.yaml`. Then delete files the new version no longer has, and connectors the previous publish recorded in its marker but this one no longer ships.
4. Write the marker last and read it back.

Every write is refused outside that extension's namespace, so pushes from different repositories may run concurrently. Connector ownership comes from the marker, not from filename prefixes, so `team-demo` never deletes `team-demo-extra`'s connector. A platform `main` push changing grants or navigation triggers the policy job, which writes only `config/grants.yaml` and `config/nav.yaml` in both environments, so revocations do not wait for an extension push. The gateway refuses to serve dot-files, including the marker. Enable bucket object versioning for emergency recovery. Connector egress and PAT/Harbor ingress must be restricted by the organization's GKE network controls after the actual service destinations are known.

## Local kind simulation

`deploy/k8s/overlays/sim` replaces the GKE CSI volume with an rclone FUSE sidecar reading the local S3-compatible object store. This privileged sidecar and `/dev/fuse` host mount are **kind-only**. The sim uses the same `harbor-extensions` Deployment and Service name as the base.

The local setup needs Docker, kind, kubectl, curl and openssl, plus local images tagged `harbor-fuse-seaweedfs:sim` and `harbor-fuse-rclone:sim`. The script checks these tags before applying resources.

```bash
deploy/sim/run.sh up
deploy/sim/run.sh verify
deploy/sim/run.sh down
```

`up` builds and loads images, creates the cluster if needed, applies the mock PAT/upstream systems and the sim overlay, and seeds the object store with tracked sample content. `verify` checks that the retired upload endpoint is absent, then runs `scripts/publish-content.sh` with the sim storage adapter for a local Git push → checked-out branch bundle → validation → extension-only bucket writes → FUSE → page, asset and catalog hot reload. It also checks file removal, an idempotent re-run, and that the Deployment generation, Pod UIDs and restart counts did not change. The test extension is removed afterward. It needs `HARBOR_PYTHON` (default `.venv/bin/python`) with `backend/requirements.txt` installed. See [the sim notes](sim/fuse-object-storage/README.md).

The local object store and rclone mount prove the content layout and hot-reload path. They do not prove GKE Workload Identity, GCS metadata consistency, the CSI driver's cache behaviour, or real Harbor SSO and upstream contracts.
