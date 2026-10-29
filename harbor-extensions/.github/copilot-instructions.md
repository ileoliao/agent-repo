# Harbor Extensions development guide (for GitHub Copilot)

This repository is the Harbor Extensions platform. Community-contributed "extensions" live in `extensions/<name>/`; each extension is a small **front-end-only** tool
that runs in the portal's sandboxed iframe and calls registered connectors through the `harbor.js` SDK. Extensions **have no backend code, and the platform stores no data**:
state that must be persisted and business rules that must be enforced belong in the source system or in the team's own service (once registered as a connector, a service is called the same way).

## Creating an extension

1. Copy `templates/extension-template/` to `extensions/<name>/` (name: lowercase letters, digits and hyphens, matching the directory name).
2. Edit `extension.yaml`: `title`, `description`, `owner` (required, a team or person), `visibility` (AD groups),
   and `capabilities` (the connector capabilities to use). Do not add other fields; unknown fields are rejected by CI.
3. Put logic in `app.js`, keep `index.html` to structure only, and put styles in `style.css`.
4. Validate locally: `cd backend && python -m harbor_platform.validate`.

## Hard rules (violations will not run or will not merge)

- **Do not write inline scripts** (`<script>…</script>`, `onclick="…"`): CSP only allows same-origin `.js` files.
- **Do not use `fetch` / `XMLHttpRequest` / WebSocket**: extensions have no network access; always use `harbor.connector(...)`.
- **Do not use `localStorage`, `document.cookie`, `alert` or `confirm`**: none of them work in the sandbox. Keep data that must be saved in a team service or the source system, and do confirmations inline in the page.
- **Do not build HTML from data with `innerHTML`**: data returned by upstream systems comes from other users, so use `textContent` or DOM APIs (see the `h()` helper in the examples). PRs that use innerHTML go to manual review.
- **Do not reference external CDNs**: only files in this extension's directory and under `../../sdk/` may be loaded. Always use relative paths: the platform may be served under a prefix such as `/extensions`.
- Only include `../../sdk/harbor.css` and `../../sdk/harbor.js`, and prefer `hx-` prefixed classes and `--hx-` CSS variables for styling.
- **Do not implement login and do not add password inputs**: the user is already signed in to the portal; use `harbor.me()` to get the identity. The portal handles session expiry, so extensions need not.
- To open a source-system page, use a normal link `<a href="…" target="_blank" rel="noopener">`; the target system handles corporate SSO itself.

These rules are checked automatically by CI (`python -m harbor_platform.validate`); violations block the merge.

## SDK

```js
const me = await harbor.me();                       // { user, display_name, groups }

// Connector: pass-through calls to the upstream system's native API; paths and query strings match the upstream docs
const snow = harbor.connector("snow");
const res = await snow.get("/api/now/table/change_request", { query: { sysparm_limit: 20 } });
if (res.ok) render(res.data.result);                // res.status / res.ok / res.data (JSON) / res.text
await snow.patch(`/api/now/table/change_request/${id}`, { state: "scheduled" });

// Whether the current user can use a capability (use it to decide whether to show a button; the gateway has the final say)
if (await harbor.can("snow", "change.write")) showApproveButton();

// A team-built service is also a connector, e.g. the outage service
const outage = harbor.connector("outage");
const r = await outage.post(`/api/outages/${id}/updates`, { message, status });
if (!r.ok) showError(r.data.detail.error.message);   // the service's own business-rule error; show it as-is
```

Gateway-level denials throw `HarborError` with `code`, `reason` and `need`:

| code | Meaning | What to do |
|---|---|---|
| `missing_group` | The user is not in the AD group the capability requires | Show `reason` to the user; `need` is the group to request; the page should degrade gracefully rather than error |
| `not_declared` | The extension did not declare this capability in `extension.yaml` | Add it to `capabilities` |
| `not_granted` | The write capability has not been granted yet | Request it in `config/grants.yaml` in your PR; the platform team approves |
| `no_capability` | The method+path is not in the connector's open list | Check the connector catalog (the portal's "Connectors" page or `connectors/*.yaml`) and use an open endpoint |
| `visibility` / `rate_limited` / `bad_path` | See `reason` | |

Errors from the upstream system itself (404, validation failures, etc.) are **not thrown**; check `res.ok` / `res.status`.

## Available connector capabilities

See `connectors/*.yaml`, or the portal's "Connectors" page. Each capability has an `allow` list (open `METHOD /path` rules; `*` matches one segment),
the required AD groups, a data class and whether it is a write operation. Only the `internal` data class is open for now.

## Merge rules

- Changes only under your own extension directory: auto-merged once CI validation passes.
- Requesting write capabilities, widening `visibility`, or changing `connectors/` or `config/`: needs platform-team review.
