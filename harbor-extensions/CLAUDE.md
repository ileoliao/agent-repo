# Harbor Extensions — working notes for agents

Prototype of a governed access layer for internal systems. People (sandboxed frontend-only extensions in a portal) and agents (CLI with a PAT) go through one passthrough gateway. Read `README.md` for setup and `docs/requirements-and-architecture.md` for the full design. The engineering diagram is `docs/architecture/component-map.svg`.

## Decisions already made (do not reopen without the owner)

- The gateway passes requests through unchanged: method, path, query, body. It only authenticates, authorizes, injects the connector credential plus a signed `X-Harbor-Identity` JWT, rate-limits and audits.
- Authorization = credential scope ∩ AD groups ∩ extension visibility ∩ declared capability ∩ write grant (`config/grants.yaml`). Data class gating and `cli_only` on top. Deny by default with a readable reason.
- The only external dependency is the PAT service (introspect, session, revoke). Harbor itself is just another connector.
- The platform stores no business data. Extension storage (`harbor.store`) was removed on purpose; do not add it back. Teams that need state build their own backend and connect it as an `identity-only` connector (see `connectors/outage.yaml` and the outage mock).
- Extensions are small community tools, not production changes. High-code only: no low-code builders, no mandated frontend framework.
- Phase 1 covers internal-class data only; no confidential or customer data.
- Platform team owns connectors and approves write grants; contributors own their extensions.
- Name is "Extension", never "app". Reuse industry concepts (Atlassian Forge, Power Platform connectors, Salesforce Named Credentials, Pomerium); do not invent new concept models.
- All code, docs and UI text are in English.

## Layout

- `backend/harbor_platform/`: `app.py` (routes, gateway, identity token, CSP), `auth.py`, `authz.py`, `paths.py`, `connectors.py`, `extensions.py`, `registry.py` (hot reload), `observe.py` (rate limit, audit), `validate.py` + `lint.py` (CI gate), `cli.py`.
- `backend/mocks/app.py`: mock PAT/AD, Harbor Release, ServiceNow, Jira and outage service. Users: alice, bob, carol, dave, pam.
- `portal/` (React, Vite): `src/bridge.ts` is the postMessage bridge.
- `sdk/harbor.js`, `extensions/`, `connectors/`, `config/`, `templates/`.
- `docs/`: requirements doc, `architecture/` (SVG, Mermaid, PNG exports), `deck/` (leadership slides).

## Working rules

- Run `cd backend && pytest` before every commit; all tests (including Playwright e2e) must pass. Add a test for each new behavior or denial path.
- Run `cd backend && python -m harbor_platform.validate` when touching extensions or connectors; keep `extension.yaml` fields within `ALLOWED_FIELDS`.
- Keep the gateway and SDK small: every component must map to a design requirement. Remove what is not needed.
- Update `README.md`, the requirements doc and the diagrams when behavior changes.
- Work on a branch and open a PR to `main` of `ileoliao/agent-repo`; the owner merges.

## Known next steps (from the rollout list)

- P0 before launch: real PAT service Kerberos login, asymmetric identity token + JWKS, secrets service for credentials, shared store (Redis) for rate limit and introspect cache, OTel spans for audit, response body size limit or streaming, CI wiring for `validate.py` exit codes.
- P1 pilot: short read caching at the gateway, PR preview links, auto-archive by traffic and owner status, on-behalf-of tokens for Jira/GitLab, `cli_only` wired to the compliance approval gate, more connectors (GitLab, directory, IM).
