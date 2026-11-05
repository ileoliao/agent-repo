# GitOps extension acceptance

The only content release trigger is a GitHub push to an extension repository's `dev` or `prod` branch. A local developer command may validate and preview but must never upload content to either environment.

## Required checks

1. Scaffold an independent extension repo and validate its UI, connector definition and local/Dev/Prod upstream addresses.
2. Push an update to `dev`; the checked-out Dev branch produces a Dev bundle and Dev alone changes after the GitOps job syncs it.
3. Confirm the bundle contains the Dev connector address and no local environment file or credentials.
4. Keep `prod` on its older commit while Dev advances. A Prod bundle must keep its Prod address and old code.
5. Merge the reviewed Dev code to `prod`, push that branch, and confirm only then does Prod receive the new code.
6. Confirm `/api/content/extensions` is absent and `harbor extension publish` is unavailable.
7. Roll back `prod` to a prior reviewed commit and confirm its previous content returns. Platform policy and revoked grants remain current.

The kind simulation in `deploy/sim/verify-gitops-push.sh` covers a local bare-remote push, branch checkout, bundle rendering and Dev FUSE visibility. GitHub branch protection, Jenkins webhook identity and credentials, separate Dev/Prod buckets, Prod reconciliation and real upstream contracts still require environment testing.
