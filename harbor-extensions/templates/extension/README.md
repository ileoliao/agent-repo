# My Extension

This repository owns one Harbor extension and its connector contract. `web/` contains only the static files to serve; keep source, tests and credentials outside it. Work on the `dev` branch; merge `dev` into `prod` with a reviewed PR when ready to release.

Create the Git remote and its `dev` and `prod` branches once. The platform team connects those branches to the corresponding environments.

Before enabling deployment, the platform team replaces the handle in `.github/CODEOWNERS`, protects both branches against direct pushes, and requires code-owner reviews and passing checks. The platform registers this repository with its Jenkins deployment job and GitHub push webhook. The extension repository contains no Jenkinsfile or deployment credentials. Concurrent releases from separate repositories fail safely and can be rerun after the other release finishes.

## Local development

Install the Harbor CLI from the platform checkout once with `npm install && npm link` there. It runs on Node; no Python is needed for this repository's local workflow.

Start your connector backend at the address in `env/local.yaml` (the template uses `127.0.0.1:3000`). Then run from this repository root:

```bash
harbor extension validate
harbor extension dev
```

Open the printed URL. The sample extension shows illustrative workflow data; replace it with your own UI and connector calls. The extension gets the whole area beside Harbor's left navigation and below its top bar. Open **Debug tools** in the top bar when needed: the overlay shows the fixed **Local Developer** identity, configured connector addresses, a read-only test button for each declared concrete GET route, and the latest SDK response. The SDK and Node preview gateway run locally; connector calls follow the declared routes and reach your backend. Real AD groups, PAT scopes, grants and signed identity claims are checked in Dev.

`connectors/*.yaml` declares allowed operations and AD groups. `env/local.yaml`, `env/dev.yaml` and `env/prod.yaml` provide only the upstream addresses. Never commit credentials; environment secrets belong to the platform.

## Release

A PR into `dev` updates the Dev branch after merge; the platform Jenkins job then deploys it to Dev. A reviewed `dev` → `prod` PR updates the Prod branch after merge and triggers the Prod job. Each environment reads its own upstream config. Connector and permission changes require platform review. Deployment credentials stay with Jenkins; no developer CLI publish command is used.

This template contains the repo contract and local tooling. The platform must connect GitHub push webhooks to its trusted Jenkins jobs before merges can actually deploy.
