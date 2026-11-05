# Harbor Extensions: Roadmap Inventory (Present / Partial / Missing)

> Historical survey of the earlier deployment design. For the current content path, see [deployment notes](../deploy/README.md). This survey is not an implementation guide.

Survey of `harbor-extensions/` on `main` (tip at survey time: `1a00a92`). Research deliverable only: no code or behaviour changes.
Two tracks: **(1)** integrate better with the company's internal Harbor, **(2)** let the community start building extensions.

Labels used throughout: **Present** (已有), **Partial** (半成品), **Missing** (缺失). Effort tags: **S** = a day or two, **M** = about a week, **L** = more than two weeks or needs another team.

## 1. What was surveyed

| Area | Path | Exists? | Notes |
|---|---|---|---|
| README | `README.md` (211 lines) | Yes | Quick start, architecture, extension contribution, CLI, rollout checklist |
| Docs | `docs/requirements-and-architecture.md`, `docs/architecture/` (SVG/PNG/Mermaid + `architecture.html`), `docs/deck/` (4 HTML slide sources) | Yes | Design and positioning are thorough. No extension-author docs. |
| SDK | `sdk/harbor.js` (v0.3.0, 124 lines), `sdk/harbor.css` | Yes | Hand-written, no types, no tests of its own, not published |
| Templates | `templates/extension-template/` (4 files) | Yes | Single "hello" template |
| Connectors | `connectors/{jira,snow,harbor-release,outage}.yaml` | Yes | All point at `${MOCK_BASE}` |
| Extensions | `extensions/{outage-console,release-calendar}` | Yes | Two real samples (read + write, team-service reference) |
| Deploy | `deploy/README.md`, `deploy/k8s/base` (Deployment+git-sync, Service, ConfigMap, PDB, SA), `deploy/k8s/overlays/sim`, `deploy/sim/` (kind: `run.sh up/verify/chaos/down`) | Yes | Only a `sim` overlay; no real environment overlay |
| Integrations | `integrations/harbor-react/` (3 files + README) | Yes | Sidebar group, nav hook, embed frame |
| Portal | `portal/` (React + Vite, pages: Catalog, Extension, Connectors, Audit, Login) | Yes | `typecheck` and `build` only; no unit tests |
| Backend | `backend/harbor_platform/` (gateway, auth, authz, registry, lint, validate, cli, observe, config), `backend/mocks/`, `backend/tests/` | Yes | 103 passed, 3 skipped (portal not built) without e2e; run locally during this survey |
| Config | `config/{platform,grants,nav}.yaml`, `config/secrets.dev.yaml` | Yes | Dev credentials file is gated on `dev_login` |
| Scripts | `scripts/dev.sh`, `scripts/smoke.py` | Yes | |
| Docker | `Dockerfile`, `.dockerignore` | Yes | Multi-stage, non-root, fallback content baked in |
| Copilot rules | `.github/copilot-instructions.md` (inside `harbor-extensions/`) | Yes | See gap C5: nested path |
| CI | `.github/workflows/` (repo root or `harbor-extensions/`) | **No** | No workflow anywhere in the repo |
| Makefile / Taskfile / `pyproject.toml` / `package.json` at project root | | **No** | |
| `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, `CODEOWNERS` | repo root and `harbor-extensions/` | **No** | |
| GCS / FUSE / gcsfuse | anywhere | **No** | The only content path is git-sync (emptyDir) |

## 2. Findings that shape the plan

- **The "CI" described in the README does not exist.** README, `copilot-instructions.md` and `docs/requirements-and-architecture.md` all say "CI runs `validate`" and "violations block the merge". The code is there (`validate.py` exit codes 0/1/2 are meaningful, and it ran clean here), but no workflow runs it, so nothing is enforced on PRs.
- **The docs are written as an internal bank product.** `contact: team-xxx@bank.internal` in the template, "the bank's engineers", `APP-DEV-ALL` AD groups, and Kerberos/PAT assumptions throughout. This is fine for the internal track but not publishable as-is to a community.
- **Everything real is mocked.** PAT/AD, Jira, ServiceNow, Harbor Release and the outage service live in `backend/mocks/`. The one open contract with Harbor is documented: `POST {pat_service_url}/introspect` returning `{active, user, display_name, groups, scopes, kind, exp}`, with an adapter point in `auth.py`.
- **Content and code are one tree today.** The deployment design assumes a separate content repo (`connectors/`, `extensions/`, `config/grants.yaml`, `config/nav.yaml`) synced by git-sync, but `GITSYNC_REPO` is a placeholder (`git.example.internal`) and nothing splits the tree or documents how.
- **Doc drift.** The root `README.md` says 85 tests, `requirements-and-architecture.md` says 132, and the code has about 92 test functions (103 passed after parametrization, excluding the 13 e2e). Minor, but it erodes trust.

## 3. Track 1: Internal Harbor integration

Priority: P0 = blocks a real pilot, P1 = needed during pilot, P2 = later.

| # | Area | Status | Current state (evidence) | Gap | Next step | Pri / effort |
|---|---|---|---|---|---|---|
| H1 | Auth / SSO | **Partial** | `auth.py` introspects PAT or session at `{pat_service_url}/introspect`, 60 s cache plus stale-if-error (`introspect_stale`). `session_cookie`, `login_url={next}`, `dev_login:false`, embed mode with `auth-required` event all exist. `integrations/harbor-react/README.md` states the contract is an open item. | Never run against Harbor's real auth service. Request/response shape unconfirmed. Session cookie scoping and name (`hx_session` vs Harbor's) undecided. No silent renewal (re-prompts on 401). | Get Harbor auth owners to confirm or publish the introspect shape. Write a one-page contract doc (request, response, error codes, TTL, revocation). If it differs, add the single-function adapter in `auth.py` plus a contract test with a recorded fixture. | P0 / S (doc), M (adapter) |
| H2 | Identity claim to downstream | **Partial** | `X-Harbor-Identity` JWT, HS256 shared key (`HARBOR_IDENTITY_KEY`), 60 s expiry, `aud` = connector. Refuses dev key when `dev_login` is off. | Asymmetric signing and JWKS endpoint not implemented. Each downstream owner has to agree on verification. | Add RS256/ES256 signing and `/.well-known/jwks.json` behind a setting, keep HS256 for sim. Publish a downstream verification snippet (Python/Java/Go). | P0 for any non-mock connector / M |
| H3 | Harbor API / CLI | **Partial** | `harbor_platform.cli` (`connectors`, `call <connector> <METHOD> <path>`), PAT in `HARBOR_PAT`, denial reasons printed for agents. Harbor Release is a connector (`connectors/harbor-release.yaml`) pointing at a mock. Harbor-side React kit exists. | CLI is not installable (no `pyproject.toml`, run as `python -m` from `backend/`). Not wired into Harbor's own CLI. Real Harbor Release API never exercised. `cli_only` approval gate on the CLI path is not implemented (only "not from browser"). | Package the CLI (`pyproject.toml`, entry point `harbor-ext`). Point `connectors/harbor-release.yaml` at real Harbor staging and record the actual endpoints. Decide with Harbor whether the CLI becomes a subcommand of Harbor's CLI. | P1 / S (package), M (real connector) |
| H4 | Harbor UI embedding | **Present** (tested on stand-in) | `integrations/harbor-react/` (nav hook, sidebar group, `ExtensionFrame`), `/api/nav?workspace=`, `nav.yaml` sections, embed mode, `harbor.context()`. e2e uses `tests/e2e/harbor_shell.html`. | Not integrated into the real Harbor React app. Files are "copy into Harbor", so they drift. | Do the copy-in as a Harbor PR (draft), or publish the kit as an internal npm package. Keep `nav.yaml` section keys in sync with Harbor sidebar groups. | P1 / S |
| H5 | Internal registry / images | **Partial** | `Dockerfile` builds (non-root UID 10001, read-only rootfs compatible). Base manifest uses `REGION-docker.pkg.dev/PROJECT/harbor/harbor-extensions` placeholders. Base images are public: `node:22-slim`, `python:3.12-slim`, `registry.k8s.io/git-sync/git-sync:v4.4.0`. | No build/push pipeline. Base images not mirrored to the internal registry or pinned by digest. No SBOM/scan. | CI job: build, scan, push to Artifact Registry on tag. Mirror or digest-pin base images and the git-sync image. | P0 / S–M |
| H6 | Secrets and config | **Partial** | `HARBOR_SECRET_<NAME>` env injection, `harbor-extensions-secrets` k8s Secret contract, `HARBOR_IDENTITY_KEY` required in prod, `secrets.dev.yaml` ignored when `dev_login` off and excluded by `.dockerignore`. | No Secret Manager wiring (External Secrets or CSI manifests). No rotation story (identity key rotation needs overlap). Connector secret names are only validated at request time. | Add an `ExternalSecret` (or CSI `SecretProviderClass`) example in the overlay. Add a startup check that every `auth.secret` referenced by a connector resolves, and make `validate` warn on unknown names. Document key rotation. | P0 / S–M |
| H7 | GKE deploy path | **Partial** | kustomize base: 2 replicas, `maxUnavailable: 0`, PDB, probes, hardened securityContext, git-sync init+sidecar, `GITSYNC_MAX_FAILURES=-1`. `deploy/README.md` has step list, own-host vs same-host trade-offs, replica caveats. | Only a `sim` overlay. No `dev`/`staging`/`prod` overlay. No NetworkPolicy, Workload Identity binding, HPA, Ingress/BackendConfig sample, or ServiceAccount annotations. `kustomize build` is not run anywhere automatically. Same-host cookie/XSS trade-off decision is open. | Add a `staging` overlay with the real values filled from the platform team (host, `pat_service_url`, origins). Add NetworkPolicy (ingress from Harbor only, egress to PAT and connectors). Decide same-host vs `extensions.<domain>`. | P0 / M |
| H8 | kind / local simulation | **Present** | `deploy/sim/run.sh up/verify/chaos/down`: 37 checks, git-sync hot-reload, PAT outage, content-repo outage, 2-replica sign-out timing. Docs list what the sim does not cover (GCE NEG, Workload Identity, NetworkPolicy). | Needs docker, kind, kubectl, openssl and network (pulls the ingress-nginx manifest at runtime). Not run in CI. | Run `verify` in a nightly or manual CI job. Keep as the regression test for any overlay change. | P2 / S |
| H9 | git-sync to GCS FUSE (known backlog) | **Missing** | No GCS or FUSE code, manifest, or doc. Content arrives only via git-sync into an `emptyDir` per pod, polled every 30 s. Fallback copy baked at `/content`. | Backlog item unstarted. Motivation to confirm: git credentials per pod, N pods polling git, cold-start dependency on git. | Write a short design note (options: keep git-sync; CI publishes a validated content bundle to a GCS bucket and pods mount it via the GCS FUSE CSI driver; or an object-store reader instead of a mount). Key design points: atomic swap (the registry hot-reloads on mtime signature, and FUSE mtime semantics and caching must be verified), who writes the bucket (post-merge CI only), consistency across replicas, and `readyz` semantics. Prototype only after the note is agreed. | P1 (note) / S, impl L |
| H10 | Content repo split | **Partial** | Design and `GITSYNC_SUBPATH`/`HARBOR_ROOT` hints in docs. Today code and content sit together. | No documented procedure to create the content repo, no CODEOWNERS (platform team on `connectors/`, `config/`), no branch protection guidance. | Document the split and add `CODEOWNERS` so the "needs platform-team review" rule is also enforced by the forge, not only by the exit code of `validate`. | P0 / S |
| H11 | Release pipeline (CI) | **Missing** | `validate.py` ready (exit 0/1/2, `--base`, `--json`). | No workflow. Exit code 2 (needs review) is not mapped to a required reviewer or label. `kustomize build`, `pytest`, portal typecheck and image build are not run. | One workflow: backend tests, portal typecheck/build, `validate --base`, `kustomize build deploy/k8s/overlays/*`. On exit 2, request review from the platform team (CODEOWNERS or label). | P0 / S |
| H12 | Observability | **Partial** | Audit: one JSON record per decision, OTel-style field names, `audit_sink: stdout` (`{"harbor_audit": {...}}`). `X-Request-ID` generated. `/healthz`, `/readyz`. | No metrics endpoint, no OTel spans or traces (documented as "later"), no dashboards or alerts, no trace-context propagation to upstream. Portal Audit page is per pod only. | Add `traceparent` propagation to upstream, a small Prometheus `/metrics` (decisions by outcome, upstream latency) or OTel SDK behind a flag. Ship a log-based dashboard for the audit lines. | P1 / M |
| H13 | Multi-tenancy | **Partial** | Harbor workspace is passed to extensions (`harbor.context()`) and used to filter nav (`nav.workspaces`). Authorization is AD-group based. | Workspace is only a UI filter: no workspace-scoped authorization, rate limits, audit field, or connector config. Rate limiting and introspect cache are per pod. | Add `workspace` to the audit record (S). Decide if workspace should ever be an authorization input (design question, likely "no for the pilot"). Redis only if exact limits are required. | P1 / S (audit field), later for the rest |
| H14 | Company GitHub (content PR flow) | **Missing** | Process is described ("open a PR, merged means live"). | No workflow, CODEOWNERS, PR template, labels, or branch protection config. No preview deploy per PR (listed as P1 in the README). | Covered by H10/H11. Add PR template with the `validate` output checklist. | P0 / S |
| H15 | Jira / Confluence | **Partial / Missing** | Jira is a connector (`connectors/jira.yaml`: `issue.read`, `issue.comment`) against a mock with a static service-account token. Confluence: no connector. | Real Jira endpoints and service account not set up. No OBO (per-user tokens, listed P1). No Confluence connector. No link-out conventions for issue keys. | Point the Jira connector at the real instance (read-only first) and verify allow lists against real API paths. Add `connectors/confluence.yaml` (read: page and search, CQL). Keep writes off until the grants process is live. | P1 / M |
| H16 | Gateway hardening for real upstreams | **Partial** | Path bypass checks (`..`, `%2e`, `%2f`, `//`), header allow-list, 1 MiB request limit, 15 s upstream timeout, rate limits. | Upstream response is read fully into memory (no size cap), no short read cache (protects Jira and ServiceNow quotas), no retry or circuit breaking. | Add a response size cap and a short TTL cache for allow-listed GETs. | P1 / S–M |

## 4. Track 2: Community extension development

| # | Area | Status | Current state (evidence) | Gap | Next step | Pri / effort |
|---|---|---|---|---|---|---|
| C1 | SDK stability | **Partial** | `sdk/harbor.js` v0.3.0: `me`, `can`, `connector().get/post/put/patch/delete`, `context`, `HarborError` with codes. Frozen global, message-based. | No written API contract or changelog. No `.d.ts` types. Version string is not checked against the portal. No SDK tests apart from the e2e. `0.x` with no stability promise. The extension includes the SDK by relative path `../../sdk/harbor.js`, so the SDK version is whatever is in the tree. | Write `docs/sdk-reference.md` (every call, `HarborError` codes, JSON shapes). Add `sdk/harbor.d.ts` (hand-written is fine). State the stability promise for `0.x`. Add an SDK version handshake test. | P0 / S |
| C2 | Templates / scaffolding | **Partial** | `templates/extension-template/` (hello world with `h()` helper). `cp -r` workflow. | One template only. No generator (`harbor-ext new`). No write-capability or team-service template. Template carries internal wording (`@bank.internal`, `APP-DEV-ALL`). | Add `scripts/new-extension.sh` (or a `new` CLI command) that copies and fills `name`. Add two more templates (list/table with `harbor.connector`, and "write with confirmation"). Neutralize internal wording via placeholders. | P0 / S |
| C3 | Local dev, kind one-shot | **Partial** | `scripts/dev.sh` runs mocks (9001) and platform (8000) and builds the portal first time. `scripts/smoke.py`. Sim users alice/bob/carol/dave/pam. Hot reload of extensions. `deploy/sim/run.sh` for kind. | Needs Python 3.11+, Node (portal build), and the whole monorepo. No `make dev`/`make test`/`make kind` entry point. No devcontainer or `docker compose up`. The kind path is ops-oriented; contributors need only dev.sh. Extensions must live inside `extensions/` of this repo (relative `../../sdk/`), so out-of-tree development is impossible. | Add a root `Makefile` (`dev`, `test`, `validate`, `kind-up`, `kind-verify`). Add a `docker compose` or devcontainer one-shot. Publish a prebuilt portal artifact so extension authors do not need Node. Longer term: allow an extension directory outside the repo (`harbor-ext dev ./my-ext`). | P0 / S–M |
| C4 | Sample extensions | **Partial** | `outage-console` (team-service connector, write, role-aware UI) and `release-calendar` (read plus write, `harbor.can`). Good coverage of patterns. | Samples are large (297 and 204 lines of JS) and domain-specific, tied to mocks. Nothing minimal beyond the template. No sample for error handling, workspace context, or `HarborError` codes. | Add one 50-line "read-only table" sample and one annotated "how HarborError is handled" sample. Link all samples from the quickstart. | P1 / S |
| C5 | Docs: quickstart, contract, publish | **Partial** | `README.md` has "Contribute an extension" (4 steps) and the SDK is documented inside `.github/copilot-instructions.md`. Architecture docs are strong. | No author-facing quickstart (zero to running extension). No schema docs for `extension.yaml` and `connectors/*.yaml` (fields only discoverable in `extensions.py`/`connectors.py`; no JSON Schema). No publish and review guide (tiers, `grants.yaml`, exit codes 0/1/2, SLA). `copilot-instructions.md` sits under `harbor-extensions/.github/`, which GitHub Copilot does not read (it only reads the repository-root `.github/`). | Write `docs/extension-quickstart.md`, `docs/extension-yaml-reference.md`, `docs/publishing.md`. Publish JSON Schemas for `extension.yaml` and connectors, and reference them in editors. Move or copy Copilot instructions to a place that will actually be loaded (root `.github/` or a documented setup step). | P0 / S–M |
| C6 | Versioning and compatibility | **Missing** | SDK `version: "0.3.0"`, portal `0.1.0`, Python package has no version. `extension.yaml` has no SDK/API version field, and unknown fields are rejected (`ALLOWED_FIELDS`). | No policy: what a breaking SDK change is, how long old SDK calls are supported, how extensions declare required SDK version. Connector capability ids are described as "stable contract" but with no deprecation process. | Add an optional `sdk: ">=0.3"` field (validated by CI, adds a new allowed field, so do it deliberately). Write `docs/compatibility.md`: semver rules for SDK, capability id stability and deprecation window. Start a `CHANGELOG.md`. | P1 / S |
| C7 | License, CONTRIBUTING | **Missing** | None of `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` exist in the repo. | Without a license, outsiders have no rights to use or contribute. `SECURITY.md` matters for a gateway that holds credentials. Internal-only content (deck, bank references) may not be releasable. | Decide the license (legal/owner decision, not code). Add `CONTRIBUTING.md` (dev setup, `validate`, review tiers, DCO or CLA), `SECURITY.md`, `CODE_OF_CONDUCT.md`. Review `docs/deck/` and internal wording before any public release. | P0 / S (after license decision) |
| C8 | CI usable by external contributors | **Missing** | No CI at all. Everything needed is runnable offline (`validate`, `pytest`, mocks), which is a good starting point. | No workflow, so no feedback on PRs. e2e needs `playwright install chromium`. `validate --base` needs a checkout of main. `kind` verify needs network. No fork-PR-safe design (no secrets needed today, which is good). | Add `.github/workflows/ci.yml`: Python tests (no e2e), portal typecheck, `validate --base`. Run e2e as a separate job. Make no step depend on secrets, so fork PRs work. Post `validate` output as a PR comment or job summary. | P0 / S |
| C9 | Extension lint and security guardrails | **Present** | `lint.py` (regex rules: fetch/XHR/WebSocket, storage, cookies, inline scripts, external resources, password inputs, absolute paths, innerHTML to review). Sandboxed iframe plus CSP at runtime. Unit tests exist. | Regex lint can be bypassed (the runtime sandbox is the real control, which is the right layering). Error messages are good. | Keep. Optionally add `--fix-hints` and a `validate --extension <name>` mode for faster local loops. | P2 / S |
| C10 | Test health | **Present** | 103 passed, 3 skipped without e2e. 13 e2e at root and under `/extensions`. | Count drift in docs. Portal has no unit tests. 3 tests skip silently without the built portal. | Fix the counts, or drop them from docs. Make the skips explicit in CI (build the portal first). | P2 / S |

## 5. Top gaps

**Internal Harbor**

1. **Real PAT/Harbor auth contract never verified** (H1). All authentication is against a mock. This is the single largest risk and also a small first step (contract doc plus fixture test).
2. **No CI, no CODEOWNERS** (H11, H10, H14). The governance model ("exit 2 means platform-team review") exists only as an exit code; nothing enforces it on a PR.
3. **No real-environment overlay, image pipeline, or Secret Manager wiring** (H5, H6, H7). Sim passes, but the path to a real GKE namespace is placeholders.
4. **Asymmetric identity claim and JWKS** (H2). Required before any real downstream can verify safely.
5. **git-sync to GCS FUSE unstarted** (H9). Needs a design note first.
6. **Observability beyond stdout JSON** (H12) and real Jira/Confluence connectors (H15) for the pilot.

**Community**

1. **No CI** (C8), so none of the contributor rules are enforced.
2. **No LICENSE, CONTRIBUTING, SECURITY** (C7). Hard blockers for any outside contribution.
3. **No author-facing docs**: quickstart, SDK reference, `extension.yaml` schema, publish guide (C5, C1).
4. **No scaffolding command and no one-shot local environment** (C2, C3). The only path is `cp -r` inside the monorepo with Python and Node installed.
5. **No versioning or compatibility policy** (C6) while SDK is 0.x and extensions load it by relative path.
6. **Internal wording baked into template and docs** (bank, AD groups, `bank.internal`) (C2, C7).

## 6. Recommended next steps

### Wins that fit in 1–2 weeks (do these first)

Ordered by dependency and payoff. All are docs, config or small scripts. None changes gateway behaviour.

| Order | Item | Covers | Effort |
|---|---|---|---|
| 1 | **CI workflow**: backend `pytest` (no e2e), portal `typecheck` + `build`, `validate --base origin/main`, `kustomize build` on all overlays; job summary with validate output; no secrets used | H11, C8, H7 | S |
| 2 | **CODEOWNERS + PR template** (platform team owns `connectors/`, `config/`, `deploy/`, `sdk/`, `backend/`; PR template with the validate checklist) | H10, H14 | S |
| 3 | **PAT/Harbor auth contract doc** (`docs/harbor-auth-contract.md`) and send to Harbor auth owners; add a recorded-fixture contract test once confirmed | H1 | S |
| 4 | **LICENSE (after decision), CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md**; scrub or flag internal-only wording | C7 | S |
| 5 | **Author docs**: `extension-quickstart.md`, `extension-yaml-reference.md`, `sdk-reference.md`, `publishing.md`; move Copilot instructions where Copilot loads them | C5, C1 | S–M |
| 6 | **Root Makefile**: `dev`, `test`, `validate`, `portal`, `kind-up`, `kind-verify`; and a `scripts/new-extension.sh` scaffold that fills the template | C3, C2 | S |
| 7 | **`staging` overlay skeleton** with `ExternalSecret`/CSI example, NetworkPolicy, and the real values left as clearly marked placeholders; digest-pin base images | H7, H6, H5 | M |
| 8 | **GCS FUSE design note** (`docs/design-content-delivery.md`): git-sync vs bucket mount vs object-store reader; hot-reload semantics; who writes the bucket | H9 | S |
| 9 | **Small code-adjacent items** (each under a day): add `workspace` to the audit record; startup check for unresolved `auth.secret`; fix test-count claims in docs | H13, H6, C10 | S |

### After that (2–6 weeks, needs other teams)

- Asymmetric identity claim plus JWKS and a downstream verification kit (H2).
- Real Jira/Confluence/Harbor Release connectors, read-only first (H15, H3), then OBO.
- Image build/push pipeline to Artifact Registry with scan (H5).
- OTel/Prometheus instrumentation and dashboards (H12); response size cap and read cache (H16).
- SDK `.d.ts`, `sdk:` compatibility field and `compatibility.md` (C1, C6); packaged `harbor-ext` CLI and out-of-tree extension dev (H3, C3).
- Prototype of the content-delivery option chosen in the GCS FUSE note (H9).
- More templates and minimal samples (C2, C4).

### Decisions needed (not engineering)

1. License and what internal material (deck, bank-specific references) can be public.
2. Same host as Harbor versus a separate `extensions.<domain>` host (affects cookie scope and XSS exposure; see `deploy/README.md`).
3. Whether the extension CLI becomes part of Harbor's CLI.
4. Whether Harbor workspace should ever be an authorization input.
5. Where the content repo lives and who owns it.

## 7. Method and caveats

- Surveyed by reading all docs and config, the gateway/auth/config/validate/lint/registry/observe code, the SDK, templates, samples, connectors and deploy manifests, and by running `python -m harbor_platform.validate` (exit 0) and `pytest --ignore=tests/e2e` (103 passed, 3 skipped) locally.
- Not executed in this survey: e2e browser tests, `deploy/sim/run.sh` (needs docker and kind with network), Harbor-side integration (no access to Harbor's code or auth service).
- Statements about Harbor's internals come only from this repo's docs; they have not been checked against the real Harbor.
