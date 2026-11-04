# Build a Harbor extension

You write a small web UI. Harbor hosts it behind the portal login. If you need a backend, you host it and Harbor connects to it.

| Part | Where it lives |
|---|---|
| **UI** (any frontend that builds to static files) | `extensions/<name>/` → published with one command |
| **Backend / API** (optional) | **You** host it; it is registered as a *connector* |

## Prerequisites

- Node.js 18 or newer. Works on macOS, Linux and Windows.
- This repository checked out. Run commands from the `harbor-extensions/` folder (the one with `cli/`).
- For publishing only: your Harbor portal URL and a personal access token (PAT). Ask your Harbor admin if you do not have them.

Use `node cli/harbor.mjs …` everywhere below. If you ran `npm link` once, you can type `harbor …` instead.

## 1. Create

```bash
node cli/harbor.mjs extension new hello-world \
  --owner "Your Team" --contact you@yourcompany.com --description "What it does"
```

Skip the flags and edit `extensions/hello-world/extension.yaml` by hand instead. Either way, `owner`, `contact` and `description` must be real values. The template placeholders are rejected.

## 2. Run locally

```bash
node cli/harbor.mjs extension dev hello-world
```

Open the printed URL. You will see "Preview User". That is the built-in mock login, not an error. Edit files under `extensions/hello-world/` and refresh. No account, cluster or network is needed.

Inside the real portal the real login and connectors are used. Preview mode only exists in this dev server and is never published.

## 3. Check

```bash
node cli/harbor.mjs extension validate hello-world
```

Exit code 0 means OK, 1 means problems. Each problem is printed as `✗ file:line: what to change`. It checks:

- `extension.yaml`: name matches the folder; real owner, contact, description; visibility set; entry file exists.
- The sandbox rules: no `fetch`/XHR/WebSocket, no browser storage or cookies, no password inputs, no inline scripts or `onclick=`, no external URLs, relative asset paths only.

Anything shown as `• note:` is not an error. It tells you what a platform reviewer will look at (for example `innerHTML`).

## 4. Publish

```bash
export HARBOR_URL=https://<your-portal>      # PowerShell: $env:HARBOR_URL="https://…"
export HARBOR_PAT=<your token>
node cli/harbor.mjs extension publish hello-world
```

Publish **runs validate first** and stops if anything fails. Then it uploads your static files and prints where to find the extension.

- `--dry-run` runs validation and lists the files, and uploads nothing. It needs no PAT.
- If `HARBOR_URL` or `HARBOR_PAT` is missing, publish says exactly which one and exits 1. It never pretends to succeed.
- `.env`, other dot-files, `*.pem`/`*.key` files and `node_modules` are never uploaded. The package limit is 25 MB.
- Publishing again replaces the previous version. Only the latest is served.

Then **sign in to the portal**, open the Extensions catalog and find your extension. It is only visible to the groups listed in `visibility`.

## Use another frontend (React, Vue, Svelte…)

Build to static files inside `extensions/<name>/`, keeping `extension.yaml` and an `index.html` entry. Two rules:

- Use relative asset paths (Vite: `base: './'`).
- Keep `<script src="../../sdk/harbor.js">` in `index.html`. It provides `window.harbor`.

Validate scans the built files too. If a library bundle trips a sandbox rule (for example the word `localStorage`), pick a different library or ask the platform team.

## Your backend

Host the API yourself, then register it as a connector so the UI can call it with `harbor.connector("<name>")`.

1. Copy `connectors/outage.yaml` to `connectors/<your-name>.yaml` and edit it: `name`, `upstream` (your service base URL), `auth` (for example `type: identity-only`), and `capabilities` (each with `allow` routes, `groups`, `data_class`, and `write: true` if it mutates).
2. Open a PR for that file, or ask the platform team to register it. The platform team approves connectors and write access.
3. Add the same capability ids to `capabilities:` in your `extension.yaml`, for example `capabilities: [mything.read]`.
4. In the UI call `await harbor.connector("mything").get("/api/items")`. Never use `fetch`; the sandbox blocks it.

The scaffold's `app.js` already calls a demo connector named `example` and shows "not configured yet" until you register one. Replace it with yours.

## Troubleshooting

| You see | Do this |
|---|---|
| `'owner' is empty or still the template placeholder` | Edit `extension.yaml` |
| `Do not use fetch()` | Use `harbor.connector(...)` |
| `Use relative paths` | `./app.js`, not `/app.js` |
| `missing settings: HARBOR_PAT` | Set the variables from step 4 |
| `HTTP 401` | Token expired or mistyped |
| `TLS certificate not trusted` | Set `NODE_EXTRA_CA_CERTS=<your-ca.pem>` |
| Published but not in the catalog | Your account is not in the extension's `visibility` groups |
| `port 5173 is busy` | `… extension dev <name> --port 5180` |

## More

- Platform overview: [../README.md](../README.md)
- Coding rules for AI assistants: `.github/copilot-instructions.md`
