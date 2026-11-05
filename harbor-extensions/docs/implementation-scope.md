# Implementation scope for extension adoption

## Supported author path

Each extension has one GitHub repository with `dev` and protected `prod` branches. Authors use the Node CLI only to scaffold, validate and preview their UI with a locally running connector backend. A push to an approved branch is the only deployment trigger. The branch-specific bundle contains static UI plus its environment-specific connector definition; bucket credentials stay with the platform Jenkins agent.

The platform runtime serves content from a read-only FUSE mount and enforces the current PAT/AD/grant authorization policy. Extension manifests request capabilities; platform policy grants them. A developer cannot gain production connector or write authority merely by editing a manifest.

## Removed from the supported path

- The CLI `publish` command and the HTTP content-publish API, Deployment, Service and ingress route.
- The deprecated host-side content-publish shim and `scripts/new-extension.sh` wrapper.

## Remaining integration gates

- Configure platform-owned Jenkins jobs to receive GitHub `dev` and `prod` push webhooks, with separate environment buckets, GCP identities and GKE access. The branch-checked bundle, full release composition, GCS upload, compare-and-swap rollout and rollback scripts are present; actual Jenkins/GCP parameters remain to be connected.
- Protect both branches, replace the CODEOWNERS placeholder and require platform review for connector, write capability, visibility and navigation changes. PR checks must block those changes without the reviewer; a warning alone is insufficient.
- Verify real PAT/SSO, production connector credentials, signed downstream identity claims and GKE FUSE cache behaviour with owning teams.
- Exercise the GCS FUSE CSI driver, Workload Identity Federation, concurrent pushes and rollback on the organization's actual GKE cluster. The kind simulation uses rclone FUSE and cannot establish those GKE properties.
