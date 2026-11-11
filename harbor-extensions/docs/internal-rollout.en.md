# Harbor Extension internal rollout and operations guide

[中文版](internal-rollout.md)

This guide is for platform maintainers. It covers first deployment, community repository onboarding, acceptance and rollback. Authors should use the [community extension developer guide](extension-developer.en.md). Authors maintain only their own extension repositories and debug locally with Node. A push after merging into `dev` or `prod` reaches a platform-owned Jenkins job. That job verifies the repository, branch and commit, then writes only that extension's own files into the environment's GCS bucket. Running Pods hot-reload the change from their read-only FUSE mount; publishing an extension never patches or restarts the GKE Deployment. Extension repositories have no deployment Jenkinsfile, GCS credentials or upload endpoint.

## 1. Gather environment parameters

Fill this table **separately for Dev and Prod**. Do not share buckets or publishing identities. `REPLACE_WITH_*` values in the repository are intentional placeholders.

| Parameter | Dev | Prod | Purpose |
| --- | --- | --- | --- |
| GCP project, GKE cluster, location and namespace | To fill | To fill | First platform deployment and platform upgrades |
| GCS bucket | To fill | To fill | The bucket root is the live content: `extensions/`, `connectors/`, `config/`; enable object versioning |
| Image repository and SHA-256 digest | To fill | To fill | Pin the platform image |
| PAT service URL, Harbor origin and login URL | To fill | To fill | `deploy/k8s/overlays/<env>/kustomization.yaml` |
| Trusted ingress proxy CIDRs | To fill | To fill | `FORWARDED_ALLOW_IPS`; never `*` |
| Jenkins agent GCP identity | To fill | To fill | Write only the matching bucket; no GKE access |
| GKE `harbor-extensions` KSA identity | To fill | To fill | Read only the matching bucket |
| Owners for PAT/SSO, connector credentials and downstream identity verification | To fill | To fill | Real integration and acceptance |

The GKE clusters need Workload Identity Federation for GKE and the Cloud Storage FUSE CSI driver on Linux nodes. Check the actual cluster version and limitations against [Google's CSI documentation](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cloud-storage-fuse-csi-driver). Use short-lived credentials for the platform deployment identity; extension repositories must not contain service-account keys.

## 2. Prepare platform resources

1. Create separate Dev and Prod buckets, namespaces, image repositories and identities. Replace the placeholders in `deploy/k8s/overlays/dev` and `prod` with real values. Pin the image by digest. Create Kubernetes Secret `harbor-extensions-secrets` with `HARBOR_IDENTITY_KEY` and required `HARBOR_SECRET_*` values; do not commit plaintext secrets.
2. Give the GKE KSA read-only access to its bucket. Give the corresponding Jenkins identity object read/write access to that bucket and no GKE or Kubernetes permissions. Enable object versioning on the bucket for emergency recovery. Restrict service ingress and gateway egress to actual Harbor, PAT and connector destinations. Network rules depend on internal addresses and are not supplied as wildcard policies here.
3. Maintain separate `grants.yaml` and `nav.yaml` files under `deploy/policy/dev/` and `deploy/policy/prod/`. The initial files grant nothing. The sample `config/grants.yaml` is for the local simulation and must not be copied into production.
4. Render and check both manifests. The checker is expected to fail while placeholders remain:

   ```bash
   kubectl kustomize deploy/k8s/overlays/dev >/tmp/harbor-dev.yaml
   kubectl kustomize deploy/k8s/overlays/prod >/tmp/harbor-prod.yaml
   node scripts/check-gke-manifest.mjs dev
   node scripts/check-gke-manifest.mjs prod
   ```

## 3. Initialize the buckets and deploy the platform once

Run the platform policy job (section 4, step 3) once for each new bucket. It writes `config/grants.yaml` and `config/nav.yaml`, and adds `extensions/.keep` and `connectors/.keep` to an empty bucket so FUSE can see the required directories. Before the job exists, a **platform maintainer** may run the same script from a controlled environment:

```bash
cd harbor-extensions
for TARGET in dev prod; do
  if [ "$TARGET" = dev ]; then BUCKET=REPLACE_WITH_DEV_BUCKET; else BUCKET=REPLACE_WITH_PROD_BUCKET; fi
  HARBOR_CI=jenkins HARBOR_SOURCE_EVENT=push HARBOR_SOURCE_REF=refs/heads/main HARBOR_SOURCE_SHA=$(git rev-parse HEAD) \
    HARBOR_POLICY_ONLY=true HARBOR_ENVIRONMENT=$TARGET HARBOR_POLICY_DIR=deploy/policy/$TARGET HARBOR_BUCKET=$BUCKET \
    bash scripts/publish-content.sh
done
```

An extension publish against an uninitialized bucket fails without writing anything. Once the section 2 manifest checks pass, connect to each GKE cluster and deploy the platform image. This deploys the platform itself; repeat it only for platform image or manifest upgrades:

```bash
gcloud container clusters get-credentials REPLACE_WITH_DEV_CLUSTER --location REPLACE_WITH_DEV_LOCATION --project REPLACE_WITH_DEV_PROJECT
kubectl apply -k deploy/k8s/overlays/dev
kubectl -n REPLACE_WITH_DEV_NAMESPACE rollout status deployment/harbor-extensions
gcloud container clusters get-credentials REPLACE_WITH_PROD_CLUSTER --location REPLACE_WITH_PROD_LOCATION --project REPLACE_WITH_PROD_PROJECT
kubectl apply -k deploy/k8s/overlays/prod
kubectl -n REPLACE_WITH_PROD_NAMESPACE rollout status deployment/harbor-extensions
```

Check that both replicas in each environment are Ready, `/readyz` reports `ok: true` and `config_errors: 0`, and the Deployment's `HARBOR_ROOT` is `/content`. On failure, first check KSA bucket read access, CSI sidecar logs, the image and the Secret.

## 4. Configure GitHub and Jenkins

1. Use **Pipeline script from SCM** for the platform Jenkins job, pointing its SCM at protected platform `main` and its script path at `harbor-extensions/jenkins/Jenkinsfile.deploy`. The publish agent uses label `harbor-content-publish` and needs Node 22, Python 3.12 with `backend/requirements.txt`, and `gcloud`. Give it a platform-managed short-lived GCP identity that can write the environment bucket. It needs no `kubectl` or cluster credentials.
2. Create one platform-managed Jenkins job for each extension repository. Fix `HARBOR_JOB_MODE=extension`, `HARBOR_REGISTERED_REPO` and `HARBOR_EXTENSION_GIT_URL` in the job configuration. Extract `X-GitHub-Event`, `repository.full_name`, `ref` and `after` from the GitHub push webhook into `HARBOR_WEBHOOK_*`. The Jenkinsfile verifies repository, `dev`/`prod` branch and actual checkout SHA. `HARBOR_DEV_BUCKET` and `HARBOR_PROD_BUCKET` are fixed job settings, never webhook input.
3. Create a separate `HARBOR_JOB_MODE=policy` job for platform `main` changes under `deploy/policy/dev/` or `deploy/policy/prod/`. It rewrites only `config/grants.yaml` and `config/nav.yaml` in both environment buckets, so authorization revocation need not wait for an extension commit.
4. Verify GitHub's webhook signature at the Jenkins ingress. Restrict who can trigger and Build/Configure the jobs. A Generic Webhook Trigger token can trigger a job with SYSTEM privileges and is not an approval mechanism. See [Jenkins job setup](../jenkins/README.md) and the [plugin documentation](https://plugins.jenkins.io/generic-webhook-trigger).
5. Protect both `dev` and `prod` branches in every extension repository against direct pushes. Require PR checks and CODEOWNERS review. Replace the platform-team placeholder in the template's `.github/CODEOWNERS` with the real handle. Platform review must cover connectors, environment addresses and requested permissions. Set `HARBOR_PLATFORM_REVIEW_ENFORCED=true` on the platform job only after these rules are active.

Do **not** load a privileged Jenkinsfile from an extension repository. Jenkins warns that allowing repository authors to edit Jenkinsfiles increases credential exposure; see its [security guidance](https://www.jenkins.io/doc/book/security/securing-org-folders-and-multibranch-pipelines/).

## 5. Accept one real extension end to end

1. Have an author create an independent repository with the Node CLI, start the connector backend named by `env/local.yaml` on their machine, and run `harbor extension validate` and `harbor extension dev`. Confirm that UI calls reach that backend.
2. Merge a PR into `dev`. Check the job's webhook repository/ref/SHA against GitHub. Its bundle should contain only this extension's `web/`, manifest and Dev connector address. The job log should show writes only under `extensions/<name>/` and `connectors/<name>-*.yaml`, and a read-back of the commit in `extensions/<name>/.harbor-publish.json`. Within the FUSE metadata cache TTL (30 seconds by default) the page and catalog update, while Pod UIDs, restart counts and the Deployment generation stay unchanged. Then test real PAT/SSO, AD groups, connector reads/writes and audit in Harbor Dev.
3. Update Dev to a second version while Prod stays unchanged; compare both buckets' publish markers and page content. Promote through a `dev` → `prod` PR. Confirm Prod uses the address from `env/prod.yaml`, then repeat the permission and functional checks.
4. Change platform Dev/Prod policy and push platform `main`. Confirm the policy job changed only `config/`, especially that revoked authorization stops working within the cache TTL. Exercise concurrent pushes from two repositories, ideally with overlapping names such as `team` and `team-api`: each writes only its own files, and neither overwrites or deletes the other's connector.

The local `deploy/sim/run.sh verify` runs the same `scripts/publish-content.sh` through temporary Git remote → branch bundle → validation → extension-only bucket writes → FUSE → page and catalog hot reload, and asserts that Pods and the Deployment did not change. It uses kind/rclone. Complete this section inside the real network to test GCS CSI caching, two-replica consistency, the Jenkins webhook and identity chain.

## 6. Roll back and authorize community use

Prefer Git revert on the affected extension branch. Jenkins validates against the **current platform policy** and republishes that extension; extension publishes never rewrite grants, so revoked authorization is not restored. If a publish fails part-way, assets are written first, `extension.yaml` next and old files are removed last, so users still see a working old or new version; fix and push again. In an emergency, restore one extension's earlier objects from bucket object versioning, but never restore old grants under `config/`.

Mark an environment ready for internal community use only after the real-environment acceptance in section 5 passes. Fill in section 1 parameters and owners. An environment with placeholders, missing branch protection or no publish rehearsal on the real GKE cluster is not ready.
