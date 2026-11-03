# Post-publish acceptance

Criteria for “extension publish works end-to-end” from a developer’s point of view. Wording is community-safe (no cluster/operator tooling required of authors).

## Must pass

1. **Scaffold + validate** — `harbor extension new <name>` creates `extensions/<name>/`; `harbor extension validate <name>` completes without hard errors.
2. **Real publish** — with `HARBOR_PAT` and `HARBOR_URL` (or `HARBOR_CONTENT_ENDPOINT`) set, `harbor extension publish <name>` reports success (not dry-run).
3. **Catalog** — the Harbor portal catalog lists the published extension by name.
4. **Static entry** — the extension’s static entry URL (portal path under `/extensions/ext/<name>/`, e.g. `index.html`) returns successfully and shows the published content.
5. **Hot update** — publish again after a content change; the portal/static entry reflects the new content without a separate rebuild step.

## Operators (local sim)

Platform operators validating the content channel against the local kind sim use:

- `deploy/sim/fuse-object-storage/run-fuse-sim.sh up` — includes the in-cluster `content-publish` service and Ingress path `/api/content`
- `deploy/sim/fuse-object-storage/verify-cli-post-publish.sh` — formal CLI → content channel → gateway checks (default `CLEAN=1`)

See [deploy/sim/fuse-object-storage/README.md](../deploy/sim/fuse-object-storage/README.md) for setup, env vars, and the operator acceptance checklist.
