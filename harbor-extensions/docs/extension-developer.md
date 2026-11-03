# Build a Harbor extension

Three ideas only:

1. **UI** — static files you edit locally and publish to Harbor’s content channel.
2. **Local preview** — like any frontend project; no cluster.
3. **API** — you host it; Harbor registers it as a **connector**. This repo does not run your backend.

Frontend framework is **not** restricted. The template is plain HTML/JS; React / Vue / Svelte / static are all fine if you ship static output here.

## Prerequisites

- Node.js 18+
- Harbor CLI installed and logged in (`harbor` on your PATH; PAT via `harbor login` or `HARBOR_PAT`)
- Work inside this repo’s `harbor-extensions/` folder (the one with `package.json` / `cli/`)

If you are developing the CLI from this checkout:

```bash
node cli/harbor.mjs extension --help
# or: npm link   then use `harbor` directly
```

## Shortest path

```bash
harbor extension new hello-world
harbor extension dev hello-world
# edit extensions/hello-world/*  → refresh the browser

harbor extension publish hello-world
# without PAT/URL this dry-runs and prints what would upload
```

Optional checks:

```bash
harbor extension validate
```

### npm scripts (same commands)

```bash
npm run harbor -- extension new hello-world
npm run harbor -- extension dev hello-world
npm run harbor -- extension publish hello-world
```

### Makefile (thin wrapper, optional)

```bash
make new EXT=hello-world
make dev EXT=hello-world
make publish EXT=hello-world
```

## Your backend

1. Host the API on your team’s service platform (or anywhere reachable).
2. Ask the platform team to **register a connector** (or open a PR under `connectors/` — platform-owned). See `connectors/outage.yaml`.
3. In the extension, declare capabilities in `extension.yaml` and call `harbor.connector("name")`.
4. Do **not** use browser `fetch` / XHR — the sandbox blocks it; the portal + gateway are the only network path.

## Rules (`harbor extension validate`)

Checked by CI / validate: no password fields, no own network calls, no browser storage/cookies for secrets, no inline scripts/handlers, no external resource loads, relative paths for SDK assets. Write capabilities and some patterns need platform review (exit code 2).

## What you should not need

Community developers do **not** run kind, FUSE, object-storage sims, rclone, or kubectl for day-to-day extension work. Those are platform/operator concerns under `deploy/sim/` (if present).

## More

- Platform overview: [../README.md](../README.md)
- Copilot / coding rules: `.github/copilot-instructions.md`
- Connector example (team-hosted API): `connectors/outage.yaml`
