# Deploying Harbor Extensions

For the environment parameter checklist, first release bootstrap, Jenkins setup and acceptance steps, use the [internal rollout runbook](../docs/internal-rollout.md).

Harbor routes `/extensions` to the `harbor-extensions` Service. The app image contains the gateway, Portal and SDK. A read-only content mount at `/content` supplies connectors, extensions, grants and navigation config. In GKE, each Deployment pins an immutable release and rolls out to change versions; the app does not write content.

## GKE base

`deploy/k8s/base` defines two app replicas, a Service, ConfigMap, ServiceAccount and PodDisruptionBudget. The Deployment uses the [Cloud Storage FUSE CSI driver](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/cloud-storage-fuse-csi-driver-ephemeral) with the required `gke-gcsfuse/volumes: "true"` Pod annotation. There is one content source and no in-Pod git client.

Before applying an environment overlay:

1. Set the environment overlay's Cloud Storage bucket and initial release ID. That `releases/<id>/` prefix must contain `connectors/`, `extensions/`, `config/grants.yaml`, `config/nav.yaml` and `config/release.json`.
2. Grant the `harbor-extensions` Kubernetes ServiceAccount read access to that bucket using the environment's Workload Identity setup.
3. Pin the image digest and set the PAT service URL, portal origin, Harbor login URL and ingress proxy CIDRs. Provide `harbor-extensions-secrets` with `HARBOR_IDENTITY_KEY` and connector credentials.
4. Give only the platform Jenkins deployment agent write access to the environment bucket and the narrow GKE Deployment patch permission. The `dev` and `prod` jobs use different identities and buckets. Extension authors receive no bucket credentials and there is no content upload API.
5. Route `/extensions` through Harbor's ingress to `harbor-extensions:80`. The health probes stay at `/healthz` and `/readyz` on the Service.

The `dev` and `prod` overlays are templates with deliberately unresolved values. Populate their bucket, immutable image digest, 40-character release ID, PAT URL, Harbor origin, login URL and trusted ingress proxy CIDRs. `node scripts/check-gke-manifest.mjs dev` (or `prod`) refuses placeholders and mutable image/content references. The image's baked `/content` copy remains useful for local `docker run`; the mounted bucket replaces it in GKE.

The platform-owned `jenkins/Jenkinsfile.deploy` is loaded by a trusted Jenkins Pipeline job from this repository. Register one extension job per repository with a fixed Git URL and repository slug, and a separate platform-policy job for `main`. The GitHub webhook supplies event, repository, ref and SHA; the job rejects anything except a registered push, checks out that branch, and verifies the checkout SHA before running the deployment script. Configure webhook HMAC verification, a dedicated job trigger, restricted build permissions and CODEOWNERS branch protection. Do not load a privileged Jenkinsfile from an extension repository: an author could edit it to use deployment credentials. Jenkins agents need Node 22, Python 3.12, `gcloud`, `gke-gcloud-auth-plugin`, `kubectl` and `jq`, plus GCP workload identity or another platform-managed short-lived credential. Job-owned `HARBOR_DEV_*` and `HARBOR_PROD_*` settings provide the bucket, namespace and GKE cluster values; extension authors cannot set them. Configure separate identities and least-privilege IAM/RBAC per environment. The `jenkins/Jenkinsfile.verify` job runs platform tests without deployment credentials.

The job uses `scripts/deploy-gke-release.sh`: bundle the pushed commit, read the Deployment's currently pinned release, compose it with the platform-owned grants/navigation policy, validate a full content snapshot, upload it to a new `releases/<id>/` prefix, then atomically patch the Deployment. A platform `main` push changing grants or navigation triggers the policy job for both environments, so revocations do not wait for an extension push. A concurrent release fails the patch's old-version test and can be rerun; a failed rollout restores the previous Deployment revision when still owned by that job. The GKE app's readiness probe requires the matching release marker and zero configuration errors. Keep release prefixes immutable; retain old prefixes for rollback. Connector egress and PAT/Harbor ingress must be restricted by the organization's GKE network controls after the actual service destinations are known.

## Local kind simulation

`deploy/k8s/overlays/sim` replaces the GKE CSI volume with an rclone FUSE sidecar reading the local S3-compatible object store. This privileged sidecar and `/dev/fuse` host mount are **kind-only**. The sim uses the same `harbor-extensions` Deployment and Service name as the base.

The local setup needs Docker, kind, kubectl, curl and openssl, plus local images tagged `harbor-fuse-seaweedfs:sim` and `harbor-fuse-rclone:sim`. The script checks these tags before applying resources.

```bash
deploy/sim/run.sh up
deploy/sim/run.sh verify
deploy/sim/run.sh down
```

`up` builds and loads images, creates the cluster if needed, applies the mock PAT/upstream systems and the sim overlay, and seeds the object store with tracked sample content. `verify` checks that the retired upload endpoint is absent, then exercises a local Git push → checked-out branch bundle → object store → FUSE → static/hot-reload path. The test extension is removed afterward. See [the sim notes](sim/fuse-object-storage/README.md).

The local object store and rclone mount prove the content layout and hot-reload path. They do not prove GKE Workload Identity, GCS metadata consistency, the CSI driver's cache behaviour, or real Harbor SSO and upstream contracts.
