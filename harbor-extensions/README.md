# Harbor Extensions · Prototype

A unified, governed access layer for internal systems: the platform team **integrates each system once and everyone reuses it**.
People (extension UIs) and agents (CLI) go through the same gateway, and every call has a known caller.
An engineer uses Copilot to write a front-end-only extension, opens a PR, and it goes live.

**The platform stores no business data.** State and business rules live in the source system or in a team-built service;
once a team service is registered as a connector, extensions and agents access it the same way
(reference implementation: the `outage` service + the `outage-console` extension).

> Prototype stage: the PAT/AD service, Jira, ServiceNow, Harbor Release and the outage service are all mocked (`backend/mocks/`).

## Quick start

```bash
pip install -r backend/requirements-dev.txt    # Python 3.11+ (requirements.txt = runtime only)
python -m playwright install chromium          # only needed for end-to-end tests
scripts/dev.sh                                 # builds the portal automatically on first run
```

Open http://127.0.0.1:8000 and sign in as one of the simulated users:

| User | Role | What differs |
|---|---|---|
| alice (Alice Wang) | Developer, outage responder | Can post outage updates but cannot declare recovery (not the commander); cannot approve change requests |
| bob (Bob Li) | Change manager | Sees an "Approve" button in the release calendar; outage is read-only |
| carol (Carol Chen) | New hire, only `APP-DEV-ALL` | Extensions open, but show which AD groups to request |
| dave (Dave Zhao) | Ops, incident commander, not in the developer group | Sees only the Outage Console; can declare recovery for outages he commands |
| pam (Pam Pan) | Platform admin | Gets an extra "Audit" page |

Smoke-check a running dev environment (HTTP/CLI checks for every simulated user, plus browser checks; `--no-browser` skips Playwright): `python3 scripts/smoke.py`

Portal dev mode (hot reload): run `scripts/dev.sh` first, then `cd portal && npm run dev`, and open http://127.0.0.1:5173 .

To try it under a path prefix, as behind Harbor's ingress: `HARBOR_BASE_PATH=/extensions scripts/dev.sh`, then open http://127.0.0.1:8000/extensions/ .

## Deployment

A separate service on GKE; Harbor's ingress routes `/extensions` to it and Harbor's own code does not change.
`Dockerfile` builds the image; `deploy/k8s/base` is the kustomize base (Deployment with a git-sync sidecar, Service, ConfigMap, PDB).
Connectors, extensions and grants are synced from git at runtime, so a merged PR goes live without a rollout. Details: [deploy/README.md](deploy/README.md).

| Setting | Env var | Default | Production |
|---|---|---|---|
| `base_path` | `HARBOR_BASE_PATH` | `""` | `/extensions` |
| content root | `HARBOR_ROOT` | repo checkout | git-sync directory |
| code assets | `HARBOR_APP_DIR` | repo checkout | `/app` in the image |
| config file | `HARBOR_CONFIG` | `config/platform.yaml` | mounted ConfigMap |
| `audit_sink` | `HARBOR_AUDIT_SINK` | `file` | `stdout` |
| `session_cookie` | `HARBOR_SESSION_COOKIE` | `harbor_session` | a name Harbor itself does not use |
| `dev_login` | `HARBOR_DEV_LOGIN` | `true` | `false`; then `HARBOR_IDENTITY_KEY` is required and `secrets.dev.yaml` is ignored |
| `login_url` | `HARBOR_LOGIN_URL` | `""` | Harbor's login page, e.g. `/login?next={next}` |

## Inside Harbor's navigation

Harbor keeps its own left sidebar and workspace switcher; the extensions show up inside it.
`integrations/harbor-react/` has the three files to copy into Harbor's React app (details in its README):

- **Sidebar data**: `GET /extensions/api/nav?workspace=…` returns what this user may open in this workspace.
  Harbor renders a bounded "Extensions" group (the user's pins + up to `max_featured` featured picks + "All extensions (N)"),
  and official extensions promoted with `nav.section` appear under an existing Harbor group (keys in `config/nav.yaml`).
  Promotions are official-tier only and always go through platform-team review.
- **Embed mode**: Harbor's route `/ext/:name` frames `/extensions/x/<name>?embed=1&ws=<workspace>`. The portal drops its top bar,
  passes the workspace to the extension (`harbor.context()`), and reports `navigate` and `auth-required` to Harbor.
- **One login**: set `session_cookie` to Harbor's session cookie and `pat_service_url` to Harbor's auth service, turn off `dev_login`,
  and set `login_url` to Harbor's login page. The portal then never shows its own login.

## Tests

```bash
cd backend
pytest                  # everything: unit/integration + real-browser end-to-end, run at the root and under /extensions (about 25 s)
pytest tests/e2e        # end-to-end only; screenshots go to tests/e2e/artifacts/
```

## Architecture

```
Browser                                                     Upstream systems
┌────────────────────────────── Portal (React) ┐
│  ┌─ sandbox iframe (opaque origin) ┐          │
│  │ Extension + harbor.js           │ postMessage │   /gw/{connector}/{verbatim path}
│  │ no network, no cookie           ├──────────────▶ bridge ───────────────▶ gateway ─passthrough─▶ Jira / SNOW / …
│  └─────────────────────────────────┘ (portal decides extension identity)│    │
└──────────────────────────────────────────────┘               ├─passthrough─▶ team-built service (e.g. outage)
CLI / agent ──── PAT ───────────────────────────────────────────▶ │
                                                                  └─ introspect ──▶ PAT service (the only dependency)
```

**Passthrough gateway** (`backend/harbor_platform/app.py`)

1. Authentication: a PAT (CLI, agent) or a browser session is introspected by the PAT service; results are cached for 60 seconds, and the cache keeps serving if the PAT service is briefly unavailable.
2. Matching: "method + path" is matched against the connector's capabilities. Path forms the upstream might reinterpret (`..`, `%2e`, `%2f`, `//`) are always rejected.
3. Authorization: `credential scope ∩ user AD groups ∩ extension visibility ∩ extension declared ∩ write capability granted`; data classes that are not open are rejected outright.
4. Forwarding: method, path, query string and body are forwarded **verbatim**; the connector's service-account credential and a signed identity claim `X-Harbor-Identity`
   (user, extension, capability, request ID, valid for 60 seconds) are injected so the downstream can record the real actor. Cookies and the caller's Authorization are not forwarded.
5. Response: the upstream status code and body are returned as-is, minus headers such as Set-Cookie. Gateway denials carry an `X-Harbor-Gateway-Error` header and a readable reason.
6. Rate limiting (user × extension × connector) and auditing (one record per decision; fields can be used directly as OTel span attributes).

**Extension isolation**

- Extension files carry `Content-Security-Policy: sandbox allow-scripts; connect-src 'none'; frame-ancestors 'self'`:
  opaque origin, no outgoing requests, no access to cookies or the parent page, even when the URL is opened directly.
- The portal only accepts messages from "this iframe" and adds `X-Harbor-Extension` itself, so an extension cannot impersonate another.
- Browser sessions must carry `X-Harbor-Extension`; together with `SameSite=Strict` and Origin checks this prevents CSRF.
- External links with `target="_blank"` in an extension open in a new tab outside the sandbox (`allow-popups-to-escape-sandbox`),
  and an extension cannot navigate the portal page away (no `allow-top-navigation`).

**Single sign-on**

Extensions have no login step. The user signs in once at the portal (in production via the PAT service's Kerberos entry point); the session is an httpOnly cookie
that extensions cannot read. Extensions learn the current user through `harbor.me()`, the portal sends every call on their behalf, and downstream systems learn the real actor from `X-Harbor-Identity`.
Extension code never touches any credential.

- Session expiry: the portal bridge intercepts 401, prompts the user to sign in again, and returns to the original extension; extensions need not handle it. In production this becomes a redirect to SSO for a silent renewal.
- Sign-out: the session is revoked in the PAT service and the gateway cache is cleared, so an intercepted old cookie stops working immediately.
- Opening a source-system page: use a normal external link in a new tab; that system handles corporate SSO itself.
- CI blocks custom login/password inputs in extensions (see "Contribute an extension" below).

## Layout

```
config/          platform.yaml (runtime config), grants.yaml (write-capability grants) and nav.yaml (sidebar sections, featured cap), both platform-team owned; secrets.dev.yaml
connectors/      connectors: upstream address, auth method, allow lists grouped by capability, AD groups, data class
extensions/      extensions: outage-console (team-built service + SNOW), release-calendar (Harbor Release + SNOW, includes write operations)
sdk/             harbor.js (extension SDK), harbor.css (design tokens)
portal/          portal (React + Vite): extension catalog, extension container and bridge, connector catalog, audit
backend/         gateway and platform (FastAPI), mock systems, tests
templates/       template for new extensions
deploy/          GKE manifests (kustomize base) and deployment notes; Dockerfile at the top level
integrations/    harbor-react: sidebar group, nav hook and extension frame to copy into Harbor's React app
.github/copilot-instructions.md   extension development rules for Copilot
```

## Onboarding a team-built service

A team builds its own backend on the internal service platform, and the platform handles identity, permissions, the entry point and UI hosting. See `connectors/outage.yaml` and
the outage service in `backend/mocks/app.py`:

1. **The platform team registers the connector**: upstream address, `auth: identity-only` (the service trusts the gateway identity claim directly and needs no service account),
   with capabilities split by role and bound to AD groups, e.g. `outage.read` (readable by dev and ops) and `outage.manage` (outage responders).
2. **The team service needs few changes**:
   - verify `X-Harbor-Identity` (signature, `aud` = connector name, expiry) and use `sub` / `name` as the actor;
   - accept requests only from the gateway (network policy or mTLS) and do no login of its own;
   - keep fine-grained business rules in the service, e.g. "only the commander can declare recovery". 4xx responses from the service are passed through to the extension as-is.
3. **Write an extension for the UI**: declare capabilities in `extension.yaml` and call the service's native API with `harbor.connector("outage")`;
   record write capabilities in `config/grants.yaml`.
4. **Agents can use it directly**: `python -m harbor_platform.cli call outage GET "/api/outages?status=active"`, with the same permissions and audit.

## Contribute an extension

1. `cp -r templates/extension-template extensions/<name>`, then edit `extension.yaml`.
2. In VS Code, ask Copilot to implement `app.js` (it reads `.github/copilot-instructions.md`).
3. `cd backend && python -m harbor_platform.validate`:
   Exit code 0 = auto-mergeable, 2 = needs platform-team review, 1 = errors.
   - Errors: invalid config; references to nonexistent capabilities; extension code that collects passwords, makes its own network requests (fetch/XHR/WebSocket),
     uses browser storage or cookies, writes inline scripts or inline event handlers, or loads external resources (rules in `backend/harbor_platform/lint.py`).
   - Needs review: requesting write capabilities, requesting non-internal capabilities, widening visibility, changing connectors or grants, using HTML injection APIs such as innerHTML.
4. Open a PR. Once merged, the host directory syncs and the change takes effect without restarting the platform.

## CLI (PAT / agent path)

```bash
cd backend
export HARBOR_URL=http://127.0.0.1:8000 HARBOR_PAT=pat_alice_cli
python -m harbor_platform.cli connectors
python -m harbor_platform.cli call jira GET "/rest/api/2/search?jql=project = PAY"
python -m harbor_platform.cli call jira POST /rest/api/2/issue/PAY-101/comment --data '{"body":"ok"}'
# -> Gateway denied (403 scope): Credential scope does not include jira.issue.comment
```

## Rollout checklist

**Required before go-live**

| Item | Prototype today | To do |
|---|---|---|
| Portal login | `/auth/dev-login` signs in by username | Issue sessions via the PAT service's Kerberos entry point; turn off `dev_login` and turn on `cookie_secure` (HTTPS) |
| PAT service contract | Mocked: `/introspect`, `/session`, `/revoke` | The real PAT service provides these three endpoints; introspect returns user, scope, AD groups and expiry |
| Session renewal | Prompts re-login on 401 | Switch to an SSO redirect with silent renewal, returning to the original page |
| Identity claim | HS256 shared secret | Asymmetric signing, with downstream verifying via JWKS; **agree the verification method with each system's owner**, a prerequisite for onboarding every connector |
| Connector credentials | `config/secrets.dev.yaml` | Inject `HARBOR_SECRET_<NAME>` from the secrets service; delete the dev credentials file |
| Multiple instances | Rate limiting and the introspect cache are per pod (manifests run 2 replicas and halve the limit) | Redis (Memorystore) only if limits must be exact |
| Observability | Audit goes to stdout as JSON (`audit_sink: stdout`) | Ship it with the log agent; later report every gateway decision as an OTel span (fields already aligned) |
| Release pipeline | `validate` runs locally; git-sync manifests ready | CI runs it on PRs: exit code 0 auto-merges, 2 requires platform-team approval; set up the content repo for git-sync |
| Image and manifests | `Dockerfile` and `deploy/k8s/base` written, layout smoke-tested | Build the image and run `kustomize build` in CI; add per-environment overlays |
| Network | Local machine | GKE on the internal network; add `/extensions` to Harbor's ingress; the platform team requests egress to each system centrally |
| Upstream responses | Read fully into memory | Set a response body size limit, or switch to streaming |

**P1 (to complete during the pilot)**

- Short-lived gateway caching of read-only requests to protect ServiceNow and Jira API quotas.
- PR previews: CI deploys a temporary host directory for each PR and generates a preview link.
- Lifecycle: automatically downgrade or archive extensions based on traffic and whether the owner is still employed (checked via AD).
- OBO: for systems that support user-level tokens (Jira, GitLab), call on behalf of the user to reduce service-account usage.
- Connect `cli_only` capabilities to the existing compliance approval gate on the CLI path (today it only guarantees "cannot be called from the browser").

**Known limitations (accepted by design)**

- Extensions are front-end only, and the UI logic in an extension can be bypassed by users with browser dev tools; any rule that must be enforced belongs in the team service or the source system
  (an extension can do at most what the user could do through the gateway anyway).
- Extension code files have no access control (they contain no data, only public front-end code).
- The platform provides no storage. Collaboration data lives in the source system, a team service, or an existing governed medium such as SharePoint, accessed through connectors.

## Documents

- [Requirements and architecture](docs/requirements-and-architecture.md)
- [Architecture diagrams (engineering)](docs/architecture/)
- [Leadership deck: positioning, architecture, outlook](docs/deck/) (slide HTML sources)
