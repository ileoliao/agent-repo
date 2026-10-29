# Harbor Extensions: Requirements and Architecture

Oct 28, 2026 · @JL

## Positioning and Scope

Harbor Extensions is the unified, governed access layer for the bank's internal systems: the platform team integrates each system once and the whole bank reuses it. People (the extension UI) and agents (the CLI) go through the same gateway, so every call is attributable to a specific caller. Engineers write frontend-only extensions with Copilot and go live by opening a PR. **The platform stores no business data**: state and business rules stay in the original systems or in team-built services. The prototype is complete and tested; see "Prototype and Rollout" at the end.

**Solves only two problems**

1. **Ecosystem integration**: the platform team integrates each internal system once and registers it as a connector for the whole bank to reuse, cutting integrations from M × N to M + N.
2. **Self-service development and release**: contributors write code and open a PR; merging means going live, with no scheduling, resource requests, or deployment process.

**Explicitly out of scope**

- Low-code, drag-and-drop building, visual workflow orchestration, form designers
- Mandating a frontend framework or shipping a built-in business component library
- Hosting arbitrary backend services (teams build backends on the bank's service platform and connect them as connectors)
- Storing business data (collaboration data lives in the original systems, team services, or existing governed stores such as SharePoint)

**Naming**: an extension runs on top of the open platform and is not a standalone application system, so going live is not a production change. The name deliberately avoids "App" so extensions are not managed to application-system standards.

**Target users**: the bank's engineers, and the GitHub Copilot they use in VS Code.

## Design Principles

1. **Extension code need not be trusted**: extensions are frontend-only and run in a sandbox; they can do no more than the visitor's own permissions allow and never touch any credential.
2. **The platform stores no business data**: state and business rules that must be enforced stay in the original systems or team services; the platform is stateless and cannot become a data channel around the original system's permissions.
3. **The gateway is the only permission decision point**: authentication, authorization, audit, rate limiting, and observability are all centralized in the gateway, which denies by default.
4. **The gateway passes requests through unchanged**: extensions call each system's native API; the gateway does not translate or wrap it, and only checks permissions and injects credentials and the identity claim.
5. **Git is the release system**: git provides versioning, review, audit, and rollback, so every permission traces back to a PR and an approver.
6. **Permissions live in AD groups**: what a user can do is decided by the bank's existing AD request process; the platform maintains no permission data.
7. **Depends only on the PAT service**: identity and authorization rely solely on the PAT service and everything else is self-contained; Harbor is just another connector, like any other system.
8. **Reuse proven industry models**: no new concepts are invented; terminology matches Atlassian Forge, Power Platform, and similar.

## Core Concept Model

The platform has only seven concepts: a connector breaks a system (including team-built services) into capabilities, and each capability is bound to AD groups. An extension declares the capabilities it needs; read capabilities are granted automatically, while write capabilities can be called only after the platform team grants them.

| Concept | Meaning | Managed by |
| --- | --- | --- |
| Principal | The person or agent making the request | AD |
| Credential | A PAT (CLI, agent) or the browser session after portal login | PAT service |
| Connector | The onboarding definition of one internal system: upstream address, auth method, credential name | Platform team |
| Capability | A set of exposed operations in a connector (`METHOD /path`), a stable contract for extensions, such as `snow.change.write` | Platform team |
| AD group | The group required to use a capability, such as `APP-SNOW-CHANGE-MGR` | AD group owner |
| Extension | Frontend code + `extension.yaml` (owner, visibility, required capabilities) | Contributor |
| Grant | The record that an extension may use a given write capability (`config/grants.yaml`) | Platform team |

**Authorization formula**: the gateway makes the same decision for every request and allows it only if all conditions hold; if a capability's data class is not opened up, the request is denied outright.

```latex
\text{allow} = \text{credential scope} \cap \text{principal AD groups} \cap \text{extension visibility} \cap \text{extension declared} \cap \text{write capability granted}
```

With the same extension, different people can use different features. An extension can call `harbor.can()` to show or hide buttons, but the gateway's decision is final. When the CLI and agents call with a PAT they do not go through an extension, so the last three terms drop out.

**Example: a connector grouped by capability**

```yaml
# connectors/snow.yaml
upstream: https://snow.internal
auth: {type: service-account, secret: SNOW_TOKEN}
capabilities:
  change.read:
    allow: [GET /api/now/table/change_request, GET /api/now/table/change_request/*]
    groups: [APP-SNOW-READ]
  change.write:
    allow: [POST /api/now/table/change_request, PATCH /api/now/table/change_request/*]
    groups: [APP-SNOW-CHANGE-MGR]
    write: true
  incident.read:
    allow: [GET /api/now/table/incident]
    groups: [APP-SNOW-INCIDENT]
    data_class: confidential   # not opened up in phase 1
```

**Example: an extension declaration**

```yaml
# extensions/release-calendar/extension.yaml
name: release-calendar
title: My Release Calendar
owner: team-platform
tier: official
visibility: [APP-DEV-ALL]
capabilities: [harbor-release.release.read, snow.change.read, snow.change.write]
```

## Architecture Components

```
Release   Git PR → CI validate (lint, schema, grants) → merge → hot reload
Host      Portal (React) → sandboxed extension iframe ⇄ postMessage bridge
          CLI / agents (PAT) ─────────────────────────────┐
Gateway   /gw/{connector}/{path}: PAT introspect → authorize → rate limit
          → forward unchanged + service credential + X-Harbor-Identity → audit
Backend   Harbor Release · ServiceNow · Jira · team-built services (e.g. outage)
```

Extensions are released through Git and run in a sandbox. Every request is sent by the portal on the extension's behalf; after the gateway evaluates it against the authorization formula, it passes the request through unchanged to a built-in connector or a team-built service. The CLI and agents access the same gateway directly with a PAT. The platform itself stores no business data.

Runtime resources (the secrets service, the OTel Collector, and a shared cache when running multiple instances) are only deployment dependencies; any comparable product can replace them, and they create no business coupling.

**Deployment**: a separate service on GKE. Harbor's existing ingress routes `/extensions` to it, so Harbor's own code does not change; the service, its cookie and the portal all live under that prefix. The image carries only platform code; connectors, extensions and grants are synced from git by a sidecar, so merging a PR still goes live without a rollout. Serving from Harbor's host shares a browser origin with Harbor's UI; a separate hostname removes that and needs no code change (see `deploy/README.md`).

## Key Flows

**Release: open a PR to go live; only permission changes need human review**

1. The contributor copies the extension template and writes the extension in VS Code with Copilot (Copilot reads `copilot-instructions.md` in the repo).
2. They open a PR to `extensions/{name}/`.
3. CI validates `extension.yaml` and checks the extension code: custom login or password inputs, self-initiated network requests, inline scripts, and external resources are all blocked.
4. Code-only changes → auto-merge; requesting write capabilities, widening visibility, or using innerHTML → platform team review.
5. After merge, the extension syncs to the host and takes effect on the next request, with no platform restart. Going live is not a production change.

**Request: the gateway passes it through unchanged**

1. The extension calls each system's native API, for example `snow.get("/api/now/table/change_request", {query})`, and hands it via postMessage to the portal, which sends it to `/gw/snow/...`. The portal determines the extension's identity from the iframe and does not trust the message content.
2. The gateway introspects the credential with the PAT service to get the user, scope, and AD groups (cached for 60 seconds; the cache keeps being used if the PAT service is briefly unavailable).
3. It matches a capability by "method + path". Path forms that the upstream would reinterpret (`..`, `%2e`, `%2f`, `//`) are always rejected, so the path that authorization matched is the path the upstream receives.
4. It evaluates the authorization formula; on denial it returns a readable reason, for example "you need to join AD group APP-SNOW-CHANGE-MGR", which Copilot can use to fix itself during development.
5. If allowed, it applies rate limiting, then forwards the method, path, query string, and request body **unchanged**, injecting only two things: the connector's service-account credential and a signed identity claim `X-Harbor-Identity` (user, extension, capability, request ID; valid for 60 seconds). The caller's Cookie and Authorization are not forwarded.
6. The upstream's status code and response body are returned unchanged (headers such as Set-Cookie are removed). The gateway's own denials carry an `X-Harbor-Gateway-Error` header, which the SDK uses to tell "gateway denial" from "upstream business error". Every decision is audited.

**Login: sign in once, at the portal only**

- The user signs in at the portal (in production, via the PAT service's Kerberos entry point) and gets an httpOnly, SameSite=Strict session cookie.
- Extensions have no login step: they cannot read the cookie, learn the current user through `harbor.me()`, and downstream systems learn the real operator from the identity claim. Extension code never touches any credential.
- Session expiry: the portal's bridge intercepts 401s and renews or re-authenticates centrally, then returns to the original extension; the extension does not need to handle it.
- Sign-out: the session is revoked in the PAT service and the gateway cache is cleared, so an intercepted old cookie is invalid immediately.
- Opening an original system's page: it opens in a new tab through a normal external link, leaving the sandbox, and the target system runs the company SSO itself; an extension cannot navigate the portal page away.
- The CLI and agents use a PAT and go through the same gateway, the same permissions, and the same audit.

## Onboarding Team-Built Services

Tools that need to keep state or enforce business rules are built by the team as their own backend on the bank's service platform; the platform handles only identity, permissions, the entry point, and UI hosting. The outage management in the prototype is onboarded this way and serves as a reference implementation.

| Who | Does what |
| --- | --- |
| Platform team | Registers the connector: upstream address, `auth: identity-only` (the service trusts the gateway's identity claim directly and needs no service account), and splits capabilities by role and binds them to AD groups, such as `outage.read` and `outage.manage` |
| Team service | Validates `X-Harbor-Identity` (signature, aud, expiry) and uses the user in it as the operator; accepts requests only from the gateway; does no login; keeps fine-grained business rules in the service |
| Extension | Declares capabilities and calls the service's native API with `harbor.connector("outage")`; shows the service's business errors as returned |
| Agent | Calls the same service through the CLI with a PAT, with the same permissions and audit |

The key to the division of labor: the gateway decides only "may this endpoint be called" (at the AD-group level), while the service decides "may this action be done" at the business level. For example, every member of the incident response team can post progress updates, but only that outage's commander can declare recovery.

## Governance and Operations

The platform team owns the platform and connectors, contributors own their own extensions, and what a user can do is decided by AD groups.

| Topic | Decision |
| --- | --- |
| Extension launch | Not a production change; positioned as a small community-contributed tool; the UI shows its tier and maintainer |
| Data scope | Phase 1 opens only internal-class capabilities, excluding confidential and customer data |
| Write operations | Allowed, provided the user is in the corresponding AD group and the extension has been granted the write capability |
| Connector registration and maintenance | Platform team: defines capabilities, binds AD groups, hosts credentials |
| Extension grant approval | Platform team: read capabilities are granted automatically; write capabilities are registered in `config/grants.yaml` and manually reviewed |
| Code rules | Checked automatically by CI: no custom login, self-initiated network requests, browser storage, inline scripts, or external resources; innerHTML goes to manual review |
| Deployment location | Internal network; the platform team requests the network policies for connecting to each system |
| Platform operations | Platform team runs the gateway, host, and connectors |
| Extension support | Contributors; `owner` is required, and the UI consistently shows the maintainer and feedback channel |

**Lifecycle**

- Tiers: experimental → community → official, promoted by usage and stability
- No visitors for a long time, or the owner leaves (checked against AD) → automatically downgraded or archived
- High-risk capabilities can be marked `cli_only`: browser extensions cannot call them, only the CLI path with its compliance approval gate can

## Industry References

The overall model matches Atlassian Forge with server-side functions removed and connectors replaced by the bank's internal systems; every part has a proven precedent.

| This platform | Industry counterpart | What we borrow |
| --- | --- | --- |
| `extension.yaml` declares capabilities | Atlassian Forge `manifest.yml` | Declarative, auditable permissions |
| sandbox iframe + `harbor.js` | Forge Custom UI + `@forge/bridge`, Figma plugins, Shopify App Bridge | Untrusted frontend isolated from the host |
| Connectors + credential hosting | Salesforce Named Credentials, Power Platform connectors | Code never gets the secrets; integrate once, reuse |
| Capabilities bound to AD groups | OAuth scopes + enterprise directory authorization | Permissions ride the existing identity system |
| Gateway passthrough + identity claim | Identity-aware proxies (such as Pomerium) | Downstream learns the real user |
| Overall philosophy | Netflix paved road | The default path is automatically compliant |

Difference from low-code platforms: this platform targets engineers and AI-generated code, and borrows only their connector governance. Connectors serve both extensions and agents (and can generate MCP tool definitions), which is the only extension beyond the proven models.

## Prototype and Rollout

The prototype covers all of P0's scope, and 116 automated tests pass; the 12 real-browser scenarios run twice, at the root and under the `/extensions` prefix used behind Harbor's ingress. A set of required items remains before production; the most critical are connecting the real PAT service and agreeing with each system (including team-built services) on how it validates the identity claim.

**Prototype contents**: a Python (FastAPI) gateway; a React portal (extension catalog, extension container and bridge, connector catalog, audit); two sample extensions: My Release Calendar (Harbor Release + SNOW) and the Outage Console (a team-built outage service + SNOW, the reference implementation for onboarding team services); the CLI; CI validation; the extension template and Copilot instructions. PAT/AD, Jira, ServiceNow, Harbor Release, and the outage service are all simulated.

**Implementation check: is it sufficient?**

| Design requirement | Prototype |
| --- | --- |
| Authorization formula, data classes, readable denial reasons | Implemented; every kind of denial has a test |
| Gateway passthrough, injected credentials and identity claim | Implemented; the simulated downstream verifies the signature and records the real operator |
| Sandbox isolation, anti-impersonation, anti-CSRF, path bypass | Implemented and tested in the browser |
| Single sign-on, session expiry, sign-out revocation, external links | Implemented (the login itself is a simulated SSO) |
| Rate limiting, audit, hot reload, team-service onboarding | Implemented |
| Deployment as a separate GKE service behind Harbor's ingress | Implemented: configurable base path, k8s probes, stdout audit, image + kustomize base with git-sync; image build not yet run in CI |
| CI: auto-merge / needs review / blocked | Implemented, including code-rule checks |
| `cli_only` | Partial: browsers cannot call it; the CLI path is not yet wired to the compliance approval gate |
| Downstream caching, PR previews, auto-archiving | Not implemented, listed in P1 |

**Implementation check: is it necessary?** The review removed SDK interfaces and test endpoints that served no purpose, and added session revocation on sign-out (previously only the cookie was deleted and the old token stayed valid) and a memory cap for long-running processes. It later also removed the originally planned extension storage (harbor.store): it would become a channel around the original system's permissions and a way to leak sensitive information, while collaboration data already has SharePoint and teams can quickly create a backend on the bank's service platform. Every remaining component maps to one of the design requirements above.

**Required before launch**

| Item | Prototype today | To do |
| --- | --- | --- |
| Portal login | Dev login by username | Connect to the PAT service's Kerberos entry point; turn off dev login, enable HTTPS and secure cookies |
| PAT service contract | Simulated `introspect` / `session` / `revoke` | The real service provides these three interfaces; introspect returns user, scope, AD groups, and expiry |
| Session renewal | Prompts re-login on 401 | Redirect to SSO for silent renewal, then return to the original page |
| Identity claim | Symmetric key (HS256) | Asymmetric signing + JWKS; **agree on the validation method with each system and its owning team**, a prerequisite for onboarding every connector |
| Connector credentials | Dev config file | Injected by the secrets service; delete dev credentials |
| Multiple instances | Rate limiting and identity cache are per pod | Acceptable for the pilot (limit set per pod); shared storage such as Redis only if limits must be exact |
| Observability | Audit written to stdout as JSON | Ship with the log agent; later report every gateway decision as an OTel span (fields already aligned) |
| Release pipeline | Validation script runs locally; git-sync sidecar in the manifests | Wire validation into CI, auto-merge or require approval by exit code; the content repo is synced into the pods |
| Network | Local machine | GKE service behind Harbor's ingress at `/extensions`; the platform team requests the egress policies to each system |
| Upstream responses | Read fully into memory | Set a response body size limit, or switch to streaming forwarding |

**P1 (complete during the pilot)**

- Short-lived gateway-side caching of read requests, to protect the ServiceNow and Jira API quotas
- PR preview links
- Automatic downgrade or archiving based on traffic and owner employment status
- Systems that support user-level tokens (Jira, GitLab) switch to on-behalf-of (OBO) calls
- Connect `cli_only` capabilities to the existing compliance approval gate on the CLI path
- More built-in connectors (GitLab, directory, IM) and pilot teams

**Known limitations (accepted by design)**

- Extensions are frontend-only, so logic in the UI can be bypassed with browser debugging tools; rules that must be enforced belong in the team service or the original system. Bypassing the UI can achieve at most what the user could already do through the gateway.
- Extension code files have no access control (they are only frontend code and contain no data).

**Risks and mitigations**

| Risk | Mitigation |
| --- | --- |
| PAT service becomes a single point of failure | Cache introspect results and keep using the cache when the service is briefly unavailable (implemented) |
| Platform team becomes an approval bottleneck | Read capabilities are granted automatically; only write capabilities, wider visibility, and innerHTML get manual review |
| An extension uses a user's identity to write data in bulk | Write capabilities are granted separately; rate limiting by user × extension × connector |
| Downstream system does not accept the identity claim | Agree on it system by system before onboarding; systems that do not accept it get read-only capabilities only |
| The first connectors are hard to use and everyone falls back to integrating on their own | P0 builds only a few connectors but does them thoroughly; the platform team builds the flagship extensions first |
| Community extensions go unmaintained | `owner` is required; extensions with no visitors for a long time or whose owner leaves are archived automatically |
| A team service does not validate the identity claim correctly, or is reachable around the gateway | The platform provides validation examples in each language and an onboarding checklist; before registering a connector the platform team verifies that forged or expired claims are rejected and that sources other than the gateway cannot connect |

**Open items**

- [ ] The specific capability lists and AD groups for the two P0 connectors
- [ ] Whether the PAT service already provides session issuance and revocation interfaces
- [ ] Availability of the internal npm / frontend dependency mirror
