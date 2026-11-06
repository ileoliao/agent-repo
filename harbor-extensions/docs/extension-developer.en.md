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
harbor extension new my-extension \
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
| `env/local.yaml` | Local backend addresses or the Harbor Dev gateway address |
| `env/dev.yaml`, `env/prod.yaml` | Real Dev and Prod backend addresses for the same connectors |

`env/*.yaml` contains addresses, never credentials. Source, tests and backend code may live in the repository, but keep them outside `web/`. The platform bundles only validated `web/` files, the manifest and the target environment's connector configuration. The platform injects connector secrets separately.

## 2. Debug locally

The default mode calls your own backend directly: `upstreams` in `env/local.yaml` points to your machine (`http://127.0.0.1:3000` in the template). Enter a Staff ID in the top bar to simulate a local identity; the CLI sends it as `X-Harbor-Local-User` to your local backend.

To use an **existing online connector** from your local UI, replace `env/local.yaml` with:

```yaml
gateway: dev
```

Declare the existing capability in `extension.yaml`, for example `snow.change.read`. If you only reuse platform connectors, do not copy their `connectors/*.yaml` files. The standalone preview CLI is not yet integrated with the existing Harbor CLI credential file. For now, it reads `HARBOR_DEV_GATEWAY_URL` (the full `/extensions` base URL) and `HARBOR_DEV_PAT` from the local process environment; integration will replace this with the initialized CLI profile. Never put credentials in the repository or web page. The Dev gateway applies the real PAT, AD group, extension declaration and grant checks, then injects the downstream credential and signed identity. The top bar shows the PAT's real identity; Staff ID impersonation is disabled. The extension and required capabilities must already be registered in Harbor Dev. Offline validation cannot confirm that an online capability exists.

After configuring either mode, run from the extension repository root:

```bash
harbor extension validate
harbor extension dev
```

Open the printed preview URL. The page calls `harbor.connector("connector-name").get("/path")`; the local proxy follows `env/local.yaml` and either calls your backend directly or forwards through Dev. Use relative static asset paths. The extension page runs in a sandboxed iframe.

Direct remote calls to your own service require HTTPS. For `service-account` connectors, the CLI reads the bearer credential from the local `HARBOR_SECRET_<auth.secret>` environment variable. Use Dev gateway mode for a remote `identity-only` service that requires Harbor's signed identity. `validate` checks all three environment files; actual online capabilities and permissions are confirmed by the Dev gateway.

## 3. Release and promote

1. Open a PR into `dev`. After checks and review, merging pushes that branch to GitHub; the platform Jenkins job deploys it to Dev.
2. In Harbor Dev, check the UI, connector reads and writes, intended AD groups, denied access and audit records. Keep fixing `dev` if needed; Prod remains on its current version.
3. When ready, open a `dev` → `prod` PR. Review both code and the backend address in `env/prod.yaml`. After approval and merge, Jenkins deploys Prod.
4. For a Prod-only urgent fix, branch from `prod`, merge the fix into `prod`, then bring it back into `dev`.

Ask the platform team to configure protection for both branches, CODEOWNERS, PR checks and repository registration first. Connector addresses, allowed routes, AD groups, write capabilities, visibility and navigation promotion require platform review. Do not put a credentialed Jenkinsfile or service-account keys in the extension repository. Developers have no `publish` command or content upload API.

The platform job performs deployment. Authors normally need only the PR checks, Jenkins release result and Dev/Prod pages. If a release fails, keep the commit and contact the platform maintainers; do not bypass the GitHub branches with a direct upload.
