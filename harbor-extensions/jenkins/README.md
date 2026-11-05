# Platform-owned Jenkins jobs

The [internal rollout runbook](../docs/internal-rollout.md) covers environment parameters, first release bootstrap and end-to-end acceptance.

Use **Pipeline script from SCM** pointing at the platform repository's `harbor-extensions/jenkins/Jenkinsfile.deploy` on protected `main`. Do not read a privileged Jenkinsfile from an extension repository. The developer only pushes `dev` or `prod`; Jenkins owns the deployment credentials and code.

For each extension repository, configure a dedicated GitHub push webhook and Jenkins job. A Generic Webhook Trigger can extract these values from the GitHub payload/header:

| Job variable | Source |
| --- | --- |
| `HARBOR_WEBHOOK_EVENT` | `X-GitHub-Event` header; must be `push` |
| `HARBOR_WEBHOOK_REPO` | `$.repository.full_name` |
| `HARBOR_WEBHOOK_REF` | `$.ref` |
| `HARBOR_WEBHOOK_SHA` | `$.after` |

Set `HARBOR_JOB_MODE=extension`, `HARBOR_REGISTERED_REPO=<owner/repo>` and `HARBOR_EXTENSION_GIT_URL=<fixed Git URL>` in the platform-owned job configuration, never from the webhook. Configure a separate `HARBOR_JOB_MODE=policy` job for platform `main` pushes that change `deploy/policy/dev/` or `deploy/policy/prod/`. Restrict webhook delivery to the registered repository and validate GitHub's HMAC signature at the Jenkins ingress. Give only platform operators Build/Configure permission on deploy jobs. Use separate webhook tokens per job; the Generic Webhook Trigger token by itself can run a job with SYSTEM privileges, so it is not an approval mechanism.

The agent label `harbor-gke-deploy` needs Node 22, Python 3.12, `gcloud`, `gke-gcloud-auth-plugin`, `kubectl` and `jq`. Give its Dev/Prod identities access only to the corresponding bucket and GKE Deployment. Configure fixed job values `HARBOR_DEV_BUCKET`, `HARBOR_DEV_NAMESPACE`, `HARBOR_DEV_GKE_PROJECT`, `HARBOR_DEV_GKE_CLUSTER`, `HARBOR_DEV_GKE_LOCATION`, and their `PROD` equivalents. Set `HARBOR_PLATFORM_REVIEW_ENFORCED=true` only after branch protection requires platform CODEOWNERS review. Jenkins must obtain short-lived GCP credentials through its platform-managed workload identity; no service-account key belongs in an extension repo.

The job verifies the registered GitHub push repository, branch and SHA against the checked-out commit. A newer push makes an older queued build fail safely. The deployment script composes and validates an immutable release before writing GCS and atomically updating the GKE Deployment. A cross-repository race fails the Deployment's old-release test; rerun the losing push after the winner finishes.

Configure an unprivileged platform verification job from `harbor-extensions/jenkins/Jenkinsfile.verify` for platform PRs. It runs Node, backend/browser and manifest tests and receives no GCP deployment identity.

The job and webhook configuration are environment-owned. This repository supplies the reviewed Pipeline scripts and rejects missing runtime values; the local kind test does not exercise Jenkins or GKE credentials.
