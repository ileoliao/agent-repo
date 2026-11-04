# Harbor extensions — end-to-end DX review (2026-11-04)

Reviewer: pi, acting as a new community developer. Branch `pi/harbor-e2e-dx`, based on `origin/cursor/harbor-extension-cli-community-dx` @ 43056ebe (PR #44). Nothing pushed, nothing merged.
Evidence: `docs/_review/evidence/` (command transcripts + portal screenshots). Cluster: local kind sim (`kind-harbor-sim`), reached through the ingress `https://harbor.sim.internal:8443`.

## Round 0 — initial review (PR #44 as-is)

| # | Gap | Severity |
|---|---|---|
| 1 | The fresh scaffold (`owner: team-xxx`, `you@example.com`, "One sentence…") **published successfully** to the platform. Nothing refused placeholders (evidence/00-baseline.txt). | P0 |
| 2 | `publish` did not validate. Without a PAT or URL it silently dry-ran and exited 0, which looks like success. | P0 |
| 3 | `validate <name>` only checked that `name:` and `index.html` exist. It ran none of the sandbox rules, so fetch/localStorage/absolute paths passed and failed later in the portal. | P0 |
| 4 | Docs told people to run `harbor login`. That command does not exist. | P1 |
| 5 | Dev server served the entire repo root, including `backend/`, `cli/` and other extensions. | P1 |
| 6 | `docs/post-publish-acceptance.md` carried an "Operators (local sim)" section naming kind, FUSE and the sim scripts. The scaffold README duplicated the quick-start. | P1 (leak) |
| 7 | Publish sent dot-files, key files and node_modules, had no size limit and gave raw HTTP errors. | P1 |
| 8 | The scaffold had a "One-sentence description" paragraph that was never replaced. | P2 |

## Round 1 — implemented

- New `cli/validate-core.mjs`, Node only, mirroring the platform's `extensions.py` and `lint.py` rules.
  - Rejects placeholder owner, contact, description and title, and the template heading.
  - Checks name = folder, visibility, entry file, tier and capability format.
  - Applies every sandbox rule: fetch, XHR, WebSocket, storage, cookie, password, inline script, inline handler, external URL, absolute path, external import.
  - Output is `✗ file:line: what to change`. Reviewer-only items print as `• note:`.
- `publish` now runs 1/3 validate → 2/3 package → 3/3 upload.
  - A validation failure stops it with exit 1 before any credential is read.
  - Missing `HARBOR_URL` or `HARBOR_PAT` is exit 1 and names the missing variable. `--dry-run` is the only way to dry-run.
  - Skips dot-files, `*.pem`, `*.key` and node_modules. 25 MB limit.
  - Friendly 401/403/404/TLS/connect errors.
  - After upload it checks that the portal catalog shows the extension for the user's account.
- `new` accepts `--owner --contact --description --title`, prints a numbered "Next" list, and says which fields still need filling.
- Removed `harbor login` from every doc and help text. Auth is `HARBOR_URL` + `HARBOR_PAT`.

## Round 2 — implemented

- Dev server only serves `/extensions/<name>/` and `/sdk/`, with traversal and encoded `..` blocked (evidence/07). It prints the validate failures up front ("publish would stop on…") without blocking preview. It also gives a clear message when the port is busy.
- Rewrote `docs/extension-developer.md` around the numbered flow create → run → check → publish, with the backend/connector checklist and a troubleshooting table. It has no operator content. Removed the "Operators" section from `post-publish-acceptance.md` and moved it to `deploy/sim/fuse-object-storage/README.md`. The root README "Contribute" section and the scaffold README were trimmed to match.
- Sim verify script updated to the new `new` flags and the new "Published '…'" output.
- Cleaned the scaffold template: removed the leftover description paragraph. The Makefile no longer mentions sim.

## Fresh-user test results

| Step | Result | Evidence |
|---|---|---|
| `new hello-pi` (no flags) | creates the scaffold and lists the 3 fields to fill in | 01 |
| `validate` / `publish --dry-run` / `publish` with PAT on the fresh scaffold | all exit 1 on placeholders, no upload | 01 |
| `new … --owner/--contact/--description` → `validate` | PASS, rc 0 | 02 |
| Inject fetch, localStorage, external script and absolute css path → `validate` / `publish` | 4 ✗ errors, publish stops. Python `harbor_platform.validate` still passes the repo, so CI is not stricter on placeholders. | 02 |
| `publish` without credentials | exit 1, names the variables | 02 |
| `dev` | preview with a mock user, shim injected, repo files not served | 07, 10 |
| Real `publish` through ingress `/api/content` with a PAT | "Published", catalog probe visible for alice | 03 |
| Portal as logged-in user (browser with `hx_session` cookie minted by the PAT service), catalog → extension frame | renders "Hello Pi / Hello, Alice Wang / Connector demo: not configured yet" | 04 (png) |
| Edit and republish | the portal frame shows the new heading (HOTMARK) within seconds | 05 (txt + png) |
| Wrong PAT | exit 1 with a readable 401 message | 06 |
| Operator `verify-cli-post-publish.sh` (CLI → content-publish → bucket → FUSE mount → gateway → catalog → hot-reload) | RESULT: PASS | 08 |
| Leak grep (sim, kind, seaweed, rclone, git-sync, fuse, kubectl, minio, "harbor login") over the community docs, template, CLI and Makefile | 0 hits. The only matches are the word "refuse" and "ECONNREFUSED". | transcript in RESULT |

The browser tests could not use the real login page because the sim has `dev_login: false`. They used a session minted by the PAT service and set as the `hx_session` cookie, which is what the production path does. No bypass URL was used.

## Remaining

P0 (platform side, not fixable in the CLI):
1. The sim `content-publish` accepts any Bearer token of 8+ characters, so there is no PAT introspection and no per-extension authorization. A production content channel must introspect the PAT and check the publisher owns the extension name. I confirmed `not_a_real_token` is accepted (evidence/06). It is documented in the operator README only.
2. Unauthenticated `GET /extensions/ext/<name>/index.html` returned 200 without any credential. The files are CSP-sandboxed and carry no data, but this conflicts with "not public static". The gateway should require a session for extension static files, or the decision should be recorded.
3. No `harbor login` and no PAT-issuing page exist. The docs say "ask your Harbor admin", and a junior cannot self-serve a PAT. The tests also needed a TLS/hosts workaround for the sim, because Node does not trust the sim CA. Users on a real certificate are fine.

P1:
- `npm link` / a global `harbor` binary is not packaged. Docs use `node cli/harbor.mjs`.
- The Node validator is a mirror of the Python rules. Add a shared test (both run on the same fixtures) so they cannot drift.
- There is no first-class build-output flow for React/Vue (only the "build into the folder" instruction). A `--dir` option on publish would help.
- Not tested on Windows (code uses `path`/`fetch` only).
- Published extensions can only be removed by an operator. Add `harbor extension unpublish`.

Other notes:
- The dirty `deploy/k8s/base/deployment.yaml` (privileged FUSE half-cutover) was **not committed** and was discarded from the working tree. Two benign local edits were lost with it: the sim `kind-cluster.yaml` host port 28080 and the macOS `mktemp` fix in `deploy/sim/run.sh`. Neither affects the running cluster.
- Test debris (`base-probe`, `x-nope`, `hello-pi`) was removed from the sim bucket.
- Untracked pre-existing extensions (`jira-glance`, `test-readonly-extension`) are left untouched. `test-readonly-extension` fails the new validate because it has placeholders, which is the intended behaviour.
