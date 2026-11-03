# My Extension

Harbor UI extension (static content).

## Local preview

```bash
harbor extension dev my-extension
```

Or from this folder (after scaffolding, the name is filled in):

```bash
npm run dev
```

Open the printed URL. No cluster or local sim required.

## Framework

Plain HTML/JS is enough. You may use **React, Vue, Svelte, or any other stack** —
build to static files in this directory (keep `extension.yaml` and an `index.html` entry).
The scaffold does not lock you to a framework.

## Publish UI

```bash
harbor extension publish my-extension
```

Requires Harbor login / `HARBOR_PAT`. Without credentials the CLI dry-runs and lists files.

## Backend / API

**Do not put business APIs in this folder.** Host your service yourself, then register it
as a Harbor **connector** (see `connectors/outage.yaml` and `docs/extension-developer.md`).
Call it from the UI with `harbor.connector("your-connector")` — never raw `fetch`.
