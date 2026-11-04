# My Extension

A Harbor UI extension (static files shown inside the portal after login).

From the `harbor-extensions/` folder (two levels up):

```bash
node cli/harbor.mjs extension dev my-extension        # local preview, mock login
node cli/harbor.mjs extension validate my-extension   # must pass before publish
node cli/harbor.mjs extension publish my-extension    # needs HARBOR_URL and HARBOR_PAT
```

Before publishing, set real `owner`, `contact` and `description` in `extension.yaml`. Placeholders are rejected.

## Framework

Plain HTML/JS by default. React, Vue, Svelte etc. are fine: build to static files in this folder (keep `extension.yaml` and `index.html`, and use relative asset paths).

## Backend

Don't put business APIs in this folder. Host your service yourself and register it as a Harbor connector (see `connectors/outage.yaml` and `docs/extension-developer.md`). Call it from the UI with `harbor.connector("name")`, never `fetch`.
