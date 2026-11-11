# Platform-owned Jenkins jobs

The [internal rollout runbook](../docs/internal-rollout.md) covers environment parameters, bucket initialization and end-to-end acceptance.

Use **Pipeline script from SCM** pointing at the platform repository's `harbor-extensions/jenkins/Jenkinsfile.deploy` on protected `main`. Do not read a privileged Jenkinsfile from an extension repository. The developer only pushes `dev` or `prod`; Jenkins owns the bucket credentials and publish code.

For each extension repository, configure a dedicated GitHub push webhook and Jenkins job. A Generic Webhook Trigger can extract these values from the GitHub payload/header:

| Job variable | Source |
| --- | --- |
| `HARBOR_WEBHOOK_EVENT` | `X-GitHub-Event` header; must be `push` |
| `HARBOR_WEBHOOK_REPO` | `$.repository.full_name` |
| `HARBOR_WEBHOOK_REF` | `$.ref` |
| `HARBOR_WEBHOOK_SHA` | `$.after` |

Set `HARBOR_JOB_MODE=extension`, `HARBOR_REGISTERED_REPO=<owner/repo>` and `HARBOR_EXTENSION_GIT_URL=<fixed Git URL>` in the platform-owned job configuration, never from the webhook. Configure a separate `HARBOR_JOB_MODE=policy` job for platform `main` pushes that change `deploy/policy/dev/` or `deploy/policy/prod/`. Restrict webhook delivery to the registered repository and validate GitHub's HMAC signature at the Jenkins ingress. Give only platform operators Build/Configure permission on publish jobs. Use separate webhook tokens per job; the Generic Webhook Trigger token by itself can run a job with SYSTEM privileges, so it is not an approval mechanism.

The agent label `harbor-content-publish` needs Node 22, Python 3.12 with `backend/requirements.txt`, and `gcloud`. Give its Dev/Prod identities object read/write access to the corresponding bucket only; it needs no GKE or Kubernetes access. Configure fixed job values `HARBOR_DEV_BUCKET` and `HARBOR_PROD_BUCKET`. Set `HARBOR_PLATFORM_REVIEW_ENFORCED=true` only after branch protection requires platform CODEOWNERS review. Jenkins must obtain short-lived GCP credentials through its platform-managed workload identity; no service-account key belongs in an extension repo.

The job verifies the registered GitHub push repository, branch and SHA against the checked-out commit. A newer push makes an older queued build fail safely. `scripts/publish-content.sh` validates a local candidate (errors another extension already has in the bucket are reported but do not block), then writes only that extension's files and connectors to the bucket and reads back its publish marker. It never touches the Deployment; Pods hot-reload within the FUSE metadata cache TTL. Pushes from different repositories may run at the same time because each publish may write only its own namespace.

Configure an unprivileged platform verification job from `harbor-extensions/jenkins/Jenkinsfile.verify` for platform PRs. It runs Node, backend/browser and manifest tests and receives no GCP deployment identity.

The job and webhook configuration are environment-owned. This repository supplies the reviewed Pipeline scripts and rejects missing runtime values; the local kind test runs the same publish script against a simulated bucket but does not exercise Jenkins, GCS or GKE credentials.
