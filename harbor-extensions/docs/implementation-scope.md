# Implementation scope for extension adoption

## Supported author path

Each extension has one GitHub repository with `dev` and protected `prod` branches. Authors use the Node CLI only to scaffold, validate and preview their UI against a local backend or existing Dev gateway connectors. A push to an approved branch is the only deployment trigger. The branch-specific bundle contains static UI plus any connector definitions owned by that extension; bucket credentials stay with the platform Jenkins agent.

The platform runtime serves content from a read-only FUSE mount and enforces the current PAT/AD/grant authorization policy. Extension manifests request capabilities; platform policy grants them. A developer cannot gain production connector or write authority merely by editing a manifest.

## Removed from the supported path

- The CLI `publish` command and the HTTP content-publish API, Deployment, Service and ingress route.
- The deprecated host-side content-publish shim and `scripts/new-extension.sh` wrapper.

## Remaining integration gates

- Configure platform-owned Jenkins jobs to receive GitHub `dev` and `prod` push webhooks, with separate environment buckets and bucket-only GCP identities. The branch-checked bundle, candidate validation and extension-scoped bucket publish are present; actual Jenkins/GCP parameters remain to be connected.
- Protect both branches, replace the CODEOWNERS placeholder and require platform review for connector, write capability, visibility and navigation changes. PR checks must block those changes without the reviewer; a warning alone is insufficient.
- Verify real PAT/SSO, production connector credentials, signed downstream identity claims and GKE FUSE cache behaviour with owning teams.
- Exercise the GCS FUSE CSI driver, Workload Identity Federation, GCS FUSE metadata-cache visibility, concurrent pushes and rollback on the organization's actual GKE cluster. The kind simulation uses rclone FUSE and cannot establish those GKE properties.
