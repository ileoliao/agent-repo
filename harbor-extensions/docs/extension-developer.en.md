# Community extension developer guide

[中文版](extension-developer.md)

This guide is for extension authors. **Each extension has its own Git repository.** Its `dev` branch supplies Dev, and its protected `prod` branch supplies Prod. The branches may contain different code for as long as needed, such as when Dev is undergoing a major revision while Prod stays stable.

The platform provides the gateway, Portal, SDK, release pipeline and authorization policy. You maintain the extension UI, connector contract and backend addresses for the three environments. Platform review applies to extension code and connector declarations. Declaring a capability does not grant access to it.

## 1. Create the repository

Install the CLI once from the platform repository's `harbor-extensions/` directory. Then switch to a working directory **outside the platform Git checkout** before creating the extension:

```bash
npm ci
npm link
cd /path/to/team-workspace
harbor extension new my-extension --standalone \
  --owner "Your Team" --contact you@company.internal --description "What it does"
cd my-extension
```

The CLI currently installs from the platform checkout. You may also run `node /path/to/harbor-extensions/cli/harbor.mjs` directly. Local development requires Node only; Python, Docker and Kubernetes are unnecessary. Create a separate GitHub repository with `dev` and `prod` branches, then ask the platform team to register it with the deployment job. **Merges will not deploy until the Jenkins webhook and branch protection are connected.**

Main repository files:

| Path | What you maintain |
| --- | --- |
| `extension.yaml` | Name, owner, visibility and requested capabilities |
| `web/` | Published static pages and assets; put framework build output here |
| `connectors/*.yaml` | Connector names, allowed methods and paths, AD groups and data classes |
| `env/local.yaml` | Backend addresses for local debugging |
| `env/dev.yaml`, `env/prod.yaml` | Real Dev and Prod backend addresses for the same connectors |

`env/*.yaml` contains addresses, never credentials. Source, tests and backend code may live in the repository, but keep them outside `web/`. The platform bundles only validated `web/` files, the manifest and the target environment's connector configuration. The platform injects connector secrets separately.

## 2. Debug locally

Point `env/local.yaml` at the connector backend running on your machine. The template defaults to `http://127.0.0.1:3000`. From the extension repository root, run:

```bash
harbor extension validate
harbor extension dev
```

Open the preview URL printed by the CLI. The page calls the backend through `harbor.connector("my-extension-api").get("/health")`; replace the example connector name with yours. The CLI forwards only declared routes and capabilities to the address already configured in `env/local.yaml`. No separate local override address is needed. Use relative static asset paths. The extension page runs in a sandboxed iframe.

Local preview uses a fixed test identity. It verifies the page, routing and connection to your local backend. Verify real PAT scopes, AD groups, platform grants, connector credentials and signed downstream identity in Dev. `validate` checks all three environment files and rejects a local address that does not point to your machine.

## 3. Release and promote

1. Open a PR into `dev`. After checks and review, merging pushes that branch to GitHub; the platform Jenkins job deploys it to Dev.
2. In Harbor Dev, check the UI, connector reads and writes, intended AD groups, denied access and audit records. Keep fixing `dev` if needed; Prod remains on its current version.
3. When ready, open a `dev` → `prod` PR. Review both code and the backend address in `env/prod.yaml`. After approval and merge, Jenkins deploys Prod.
4. For a Prod-only urgent fix, branch from `prod`, merge the fix into `prod`, then bring it back into `dev`.

Ask the platform team to configure protection for both branches, CODEOWNERS, PR checks and repository registration first. Connector addresses, allowed routes, AD groups, write capabilities, visibility and navigation promotion require platform review. Do not put a credentialed Jenkinsfile or service-account keys in the extension repository. Developers have no `publish` command or content upload API.

The platform job performs deployment. Authors normally need only the PR checks, Jenkins release result and Dev/Prod pages. If a release fails, keep the commit and contact the platform maintainers; do not bypass the GitHub branches with a direct upload.
