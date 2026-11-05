# GKE convergence — local verification

## Changes verified

- Standalone bundles copy only `web/` and the validated manifest; `credentials.json` at repository root stays out. Connector names are scoped to the extension ID. The Node preview serves `web/`, denies `env/`, and reaches a connector backend on local loopback.
- Jenkins push bundling checks branch ref and checkout commit, including detached checkouts. The platform-owned `jenkins/Jenkinsfile.deploy` verifies the webhook repository/ref/SHA and owns the GCP credentials; extension repositories contain no deployment Jenkinsfile. Platform policy changes on `main` use a separate trusted Jenkins job.
- The platform composes full immutable release directories, copies platform-owned grants and navigation, validates the snapshot, uploads it to a new GCS prefix, and patches the Deployment with a previous-release test. Failed rollouts use `rollout undo` when the job still owns the Deployment. GKE readiness requires a matching release marker and zero configuration/reference errors.
- Dev/Prod Kustomize templates pin an image digest and release path and reject unresolved parameters. The runtime no longer trusts arbitrary forwarded-header sources by default.

## Results

- `npm run test:dx`: 9 passed, including live Node preview to local HTTP backend, secret exclusion, branch mismatch and policy-only release composition.
- Backend `python -m pytest -q`: 140 passed; one existing Starlette deprecation warning. Browser tests required unsandboxed Chromium launch.
- `deploy/sim/run.sh up` and `verify`: passed. Dev v1 and v2 became visible through the kind object-store/FUSE path, Prod stayed on v1 until merge/push, and the retired upload endpoint returned 404. The verify script uses a temporary bare Git remote and rclone FUSE, not GitHub or GCS.
- `kubectl kustomize` for base, sim, dev and prod: passed. `node scripts/check-gke-manifest.mjs dev` rejected unresolved placeholder parameters as intended. `bash -n` and `git diff --check`: passed.

## External gates

The actual organization parameters were deliberately left blank at the user's direction. Configure GitHub branch protection and CODEOWNERS, Jenkins push webhooks and trusted jobs, separate bucket/IAM identities and GKE RBAC, initial content releases, ingress/egress policy, production secrets, PAT/SSO and downstream identity contracts. Run a real Jenkins-triggered two-replica GKE/GCS FUSE release, concurrent push and rollback drill. This machine has a kind context and no Jenkins or `gcloud` binary, so those checks were not run here. The Jenkinsfile has been reviewed as code but not executed by Jenkins.
