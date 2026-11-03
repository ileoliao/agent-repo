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

From this repo checkout (works before `harbor` is on your PATH):

```bash
node cli/harbor.mjs extension new hello-world
node cli/harbor.mjs extension dev hello-world
# open the printed URL — first load shows "Preview User" (expected mock, not an error)
# edit extensions/hello-world/*  → refresh the browser

node cli/harbor.mjs extension publish hello-world --dry-run
# with PAT + HARBOR_URL (after harbor login), omit --dry-run to upload
```

After you install/link the CLI globally, the same commands are `harbor extension …`.

```bash
harbor extension new hello-world
harbor extension dev hello-world
harbor extension publish hello-world
```

Optional checks:

```bash
harbor extension validate hello-world   # one extension, Node-only structural check
harbor extension validate               # all extensions (+ Python lint if present)
```

`harbor extension dev` runs in **preview mode**: the dev server injects a mock `harbor` (`me()` → "Preview User", `can()` → true, connectors return empty demo JSON). Published files are untouched; inside the real portal the real SDK is used.

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

## Get a PAT / HARBOR_URL

Only needed for `publish` (preview and validate work offline).

```bash
harbor login
# or
export HARBOR_URL=<your Harbor portal URL>
export HARBOR_PAT=<your personal access token>
```

Don't know the URL or how to get a PAT? Ask your Harbor admin. Without them, `publish` dry-runs.

## Your backend

Host the API yourself, then register it as a connector.

**Connector checklist**

1. Copy `connectors/outage.yaml` to `connectors/<your-name>.yaml` as a model.
2. Fill the required fields: `name`, `upstream` (your service base URL), `auth` (e.g. `type: identity-only`), `capabilities` (each with `allow` routes, `groups`, `data_class`, `write` if mutating).
3. Open a PR under `connectors/`, or ask the platform team to register it.
4. List the same capability names in your `extension.yaml`; they must match.
5. Call it from the UI with `harbor.connector("<your-name>")`.
6. Never use `fetch` / XHR — the sandbox blocks it.

## Rules (`harbor extension validate`)

Checked by CI / validate: no password fields, no own network calls, no browser storage/cookies for secrets, no inline scripts/handlers, no external resource loads, relative paths for SDK assets. Write capabilities and some patterns need platform review (exit code 2).

## What you should not need

You don't need a cluster or any platform tooling (kind, FUSE, kubectl) for extension work.

## More

- Platform overview: [../README.md](../README.md)
- Copilot / coding rules: `.github/copilot-instructions.md`
- Connector example (team-hosted API): `connectors/outage.yaml`
