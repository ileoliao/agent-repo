# Local FUSE content simulation

The kind overlay mounts an S3-compatible bucket into the standard `harbor-extensions` Deployment with an rclone sidecar. SeaweedFS provides the local S3 API (`minio-fuse` is the historical Service name). This is the only content path in the kind sim.

Run from `harbor-extensions/`:

```bash
deploy/sim/run.sh up
deploy/sim/run.sh verify
```

`up` seeds tracked sample content into `harbor-content`. `verify` checks that `/api/content/extensions` is absent and runs [the Git push acceptance script](../verify-gitops-push.sh): scaffold, push to a temporary bare remote, checkout the `dev` and `prod` branches, render bundles, sync the Dev bundle through a temporary in-cluster operator pod, verify FUSE visibility and hot reload, then clean up. A bare remote stands in for GitHub locally; the real Jenkins webhook and GKE deployment are not connected yet.

There is no content-publish Deployment, Service or ingress route. Production bucket writes must be performed by an identity bound to the approved GitHub branch workflow, not by an extension author's PAT.

The rclone sidecar is privileged and uses `/dev/fuse` from the kind node. Production uses the GKE Cloud Storage FUSE CSI driver instead; the kind test does not establish production IAM or GCS cache semantics. See [deployment notes](../../README.md).
