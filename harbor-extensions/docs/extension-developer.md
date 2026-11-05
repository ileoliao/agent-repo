# Build a Harbor extension

Each extension belongs in its own Git repository. Its `dev` branch supplies Dev; its protected `prod` branch supplies Prod. The branches may run different code for as long as the team needs. The platform repo keeps the gateway, Portal, SDK and shared policy.

## Repository contents

```text
extension.yaml         UI metadata, visibility and requested capabilities
web/                   only static UI published (or your framework's built static output)
connectors/*.yaml      team-owned connector contracts: allowed routes, groups, data class
env/local.yaml         local backend addresses
env/dev.yaml           Dev backend addresses
env/prod.yaml          Prod backend addresses
```

These files contain no credentials. Keep source, tests, backend code and credentials outside `web/`. The platform injects secrets separately. A capability declaration is a request, not a permission grant; connector and write-access changes require platform review.

## Create and debug

The current CLI is run from a Harbor platform checkout. Run `npm install` and `npm link` once from `harbor-extensions/`, or call `node /path/to/harbor-extensions/cli/harbor.mjs` directly. Local development uses Node only; no Python, Docker, cluster or Portal build is needed. A separately distributed CLI package is future work.

```bash
harbor extension new my-extension --standalone \
  --owner "Your Team" --contact you@company.internal --description "What it does"
cd my-extension
# Start your backend at the address in env/local.yaml (template: 127.0.0.1:3000)
harbor extension validate
harbor extension dev
```

Create the remote repository and its `dev` and `prod` branches once. Until the platform GitOps integration is attached, merges will not deploy automatically.

Open the printed local preview URL. The UI and Node preview gateway run locally; the gateway loads this repo's connector routes and forwards to the backend in `env/local.yaml`. It uses a fixed **Local Developer** identity. It checks route and capability declarations, but does not emulate production AD groups, PAT scopes, signed identity claims or platform grants. Those need Dev verification. `harbor extension validate` checks all three environment files and refuses a local upstream that is not localhost.

The extension runs in a sandboxed iframe. Use `harbor.connector("my-extension-api").get("/health")` rather than `fetch`. The backend is started by the team, not by the CLI. Keep static asset paths relative; `../../sdk/harbor.js` supplies the SDK.

## Release through Git

1. Develop and submit a PR to `dev`. Merging it makes that branch the desired Dev content.
2. Test the deployed extension and connector against Dev services.
3. When ready, submit a `dev` → `prod` PR. Review code and Prod connector-address/permission changes; merge to make `prod` the desired Prod content.
4. For an urgent Prod fix, branch from `prod`, release it there, then bring the fix back to `dev`.

Developers do not run `publish` for standalone repositories. The platform's GitOps job checks out the target branch and renders its content with:

```bash
node /path/to/harbor-extensions/scripts/gitops-bundle.mjs \
  /path/to/extension-repo dev /tmp/content-bundle  # or prod
```

The builder refuses a checkout whose Jenkins-verified push ref and commit do not match the target environment. The bundle contains only `web/` as `extensions/<name>/` plus its validated manifest and environment-specific `connectors/*.yaml`. A platform-owned Jenkins job composes it with the previous complete release, validates the result, writes a new immutable GCS prefix, then pins the GKE Deployment to that release. Jenkins holds deployment identity; the extension repository has no deployment pipeline file.

## Existing platform samples

The sample extensions under this platform checkout remain for its local simulation and tests. They are not the target layout for team-owned extensions, and there is no direct upload command or API.
