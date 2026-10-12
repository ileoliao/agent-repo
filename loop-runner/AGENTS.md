# AGENTS.md: guide for AI agents working on Loop Runner

Read this before changing code in this repository. It states what the system is, the contracts other code and people depend on, and the invariants you must not break. Human-facing usage docs are in README.md (Chinese).

## What this is

A VS Code extension that runs VS Code custom agents (`.github/agents/*.agent.md`) **unattended**, on Copilot models via the VS Code Language Model API (`vscode.lm`). It adds only what VS Code lacks natively:

- scheduled triggers with a zero-token wake check
- handoffs between agents
- human gates (`ask_human`, `request_approval`) that **pause and later resume** the same conversation
- command/write policy, secret injection, and an audit trail

The deployment constraint is real: the target environment allows only GitHub Copilot inside VS Code. No GitHub Actions, no Copilot coding agent, and no other agent CLIs. Do not propose replacing the runtime with any of those.

## Scope is frozen (v1.0)

Do not add features. In particular, do not add:

- per-agent memory beyond the standing-notes file below, or context compaction
- parallel workers
- built-in notification channels or business integrations

Bug fixes, security fixes and test improvements are welcome. If a change seems to need a new feature, stop and ask the human.

**Approved additions (2026-10-11): the console.** The owner approved a native console on top of the existing surfaces: the status bar line (running agent, step, next wake), the sidebar "Agents" group (state, next run, last wake check, opens the agent file), "Recent runs" with the files each run wrote, and "Open Latest Result" reading `end.outputs`. It stays native (no chat, no notifications). The one data addition is the optional `outputs` field on the `end` audit event. Setup checks and a sample-agent command are not approved yet.

**Approved (2026-10-11): pi as the loop.** The owner decided the basic harness should be pi's `Agent` rather than our own loop. `runItem`'s interface, the checkpoint format and the audit events are unchanged; the e2e suite and the sim pass on it. Tools are executed sequentially. pi validates tool arguments against the schemas (strings such as `"5"` are coerced; a missing required field comes back as a tool error).

**Approved (2026-10-11): `@loop` in the Chat window and standing notes.** The owner asked to steer agents by conversation. `@loop` (`/status`, `/pending`, or free text) uses the model picked in Chat. It reads team state with tools and can only *propose* changes (schedule, task text, role edit, standing note, one-off task, answer a question, start/stop); the user sees the diff and presses Apply, and `applyChange` refuses a file that changed since it was proposed. Approvals are never decided in chat: they stay in the console, where the exact command and files are shown. Role and schedule edits write `.github/agents/*.agent.md` on the human's click, which is the only path by which those files change (invariant 5 still binds the agents themselves).

**Approved (2026-10-12): chat with each agent.** The console opens on a Chat tab: one conversation per team agent, and the Overview tab keeps everything else (needs-you, agents, runs). The human can write to an agent that is **working, waiting for them, queued or idle**; the message reaches it at the next opportunity (see "Messages from the human" below). Questions and approvals appear inside the conversation and are answered there; approvals still show the exact command and the files and are bound to their hashes. **Cancel this run** ends the current run as `cancelled` (not retried, unlike Stop Team). The agent's side of the conversation is not stored again: it is read from the audit files.

**Approved additions (2026-10-11), second batch:** approval bound to what the reviewer saw (the console shows each draft file and sends its sha256; `approveAndRun` refuses if a file changed since or was never shown), run guardrails (stalled after 3 identical results, `loopRunner.maxMinutes`), and the optional `loop.maxRunsPerDay`. A capped wake is recorded as a `wake` audit event with `wake:false, capped:<n>`.

**Approved addition (2026-10-11): the Loop Console webview.** After the owner found the native surfaces too hard to read, a single webview page (`Loop Runner: Open Console`, also the status bar item) shows what needs you (answer, approve with the exact command shown, reject), the agents, and a step timeline with output files for each recent run. It only reads `.loop/` and calls the existing gate functions; no new data contract, no new runtime behaviour.

## Division of labour (the core design rule)

- **Capabilities live in Skills** (`.github/skills/<name>/SKILL.md` plus `scripts/`). The runtime never knows about HarborSense, Jira, Git hosting, or any business system.
- **Roles are native VS Code agent files.** Loop-only settings live in a `loop:` block that VS Code ignores.
- **The runtime** only schedules, routes, gates, enforces policy, injects secrets, and audits.

If you find yourself writing business logic in `src/`, it belongs in a skill instead.

## Module map and dependency rule

| File | Responsibility | Imports `vscode` at runtime? |
|---|---|---|
| `frontmatter.ts` | Dependency-free YAML subset: nested maps, lists of maps, block scalars, quote-aware comments | no |
| `cron.ts` | 5-field cron matcher (local time; DOM/DOW OR semantics) | no |
| `team.ts` | Load agents and skills, `validateTeam`, `pickModel` | no |
| `policy.ts` | Allow/deny decisions for commands and writes; hard rejects (substitution, redirection, chaining); `skillScriptRule` | no |
| `exec.ts` | Loop Runner shell wrapper: allowlisted env, secret injection, redaction, output cap (keeps the first and the real last `cap/2` chars). Process spawn/kill is pi's | no |
| `vendor/pi/` | Vendored pi tool implementations (bash, read, write, edit, ls, find, grep). No TUI | no |
| `queue.ts` | File-backed state: work items, gates, checkpoints, audit | no |
| `wake.ts` | `checkWake`: runs `loop.wakeIf` and interprets its exit code | no |
| `gates.ts` | Resolve gates (answer, approve-and-run, reject) and `notify` | no |
| `tools.ts` | Generic tool schemas and `runTool` | types only (elided) |
| `runner.ts` | One work item on pi's `Agent` (`@earendil-works/pi-agent-core`): `streamFn` over `vscode.lm`, tools via `runTool`, `finishTurn` for park, finish, caps and checkpoints. Converts between pi messages and `PlainMsg` | yes |
| `inbox.ts` | Sidebar tree view and gate rendering | yes |
| `outbox.ts` | `latestOutput`: newest file under `.loop/outbox/` (fallback for Open Latest Result). Pure, no `vscode` | no |
| `runs.ts` | `recentRuns` and `outputsFrom`: read-only summaries of `.loop/runs/*.jsonl`. Pure, no `vscode` | no |
| `status.ts` | `agentRows` and `nextWake`: team state, next scheduled wake, last wake check. Pure, no `vscode` | no |
| `thread.ts` | The human's messages (`postHumanMessage`, `pendingMessages`, `markDelivered`), `buildThread` (the conversation with one agent, from those messages plus the audit), `chatState`, `routeFor`, `conversationContext`. Pure, no `vscode` | no |
| `textutil.ts` | `clip`, `firstLine`, `brief`. Pure | no |
| `console.ts` | `consoleModel`, `stepsOf`, `renderBody`/`renderPage`: the console's data and HTML (every value escaped, one nonce script). Pure, no `vscode` | no |
| `consoleView.ts` | Webview panel host: forwards page actions to the existing commands and gate functions; opens only files inside the workspace | yes |
| `manage.ts` | `Change` for a schedule, task, role edit or memory note (`proposeSchedule`, `proposeRoleEdit`, `proposeRemember`, `proposeForget`), `diffOf`, `applyChange`, `memoryFor`. Patches single lines of the `loop:` block; nothing is written until `applyChange` | no |
| `chatTools.ts` | The tools behind `@loop`: reads answer at once, every `propose_*` returns a Proposal (title, diff, `apply`). Pure over a small host interface | no |
| `chat.ts` | The `@loop` chat participant: model tool loop, Apply and Dismiss buttons | yes |
| `extension.ts` | Glue: `TeamService` (tick, schedule, single worker), commands, notifications, secrets | yes |

**Rule:** keep `vscode` out of every module marked "no". The test suite loads those modules without VS Code; `runner.ts` is tested through a mock `vscode` module.

## Lifecycle of a work item

1. **Trigger.** Every 20 s `TeamService.tick()` checks `loop.schedule`. When due, `checkWake` runs `loop.wakeIf`. Exit 0 enqueues an item whose context is the probe's stdout. Exit 1 does nothing (no model call). Any other exit is alerted once, until it recovers. A manual task from the "Give an Agent a Task" command is enqueued directly.
2. **Queue.** `nextItem` picks the oldest runnable item across agents. There is exactly one worker, FIFO.
3. **Run.** `runItem` builds the prompt, or rebuilds it from a checkpoint, and loops: `sendRequest(toolMode=Auto)` (Copilot rejects Required with more than one tool, inside the response stream, so there is no Required attempt and no fallback), then execute tool calls in order, then feed results back. It stops on `finish`, `maxSteps`, cancellation, model error, or a gate.
4. **Outcomes.**
   - `handoff` enqueues an item for a teammate with the same `chainId` and `hop+1`.
   - A gate saves a checkpoint and returns `waiting`; the item moves to `queue/_waiting`.
   - `finish` completes the item.
5. **Human.** The human resolves the gate in the Loop Inbox. `gates.ts` writes `gate.outcome`, and `wake()` moves the item back to its queue with `resumeGate` set.
6. **Resume.** `runItem` loads the checkpoint and appends one User message holding every tool result of the parked turn, with the parked call's result replaced by `gate.outcome`. It then continues; the step count carries over.

## Messages from the human

A message is a file in `.loop/chat/<agent>/`, `pending` until the model has been given it. Where it goes depends on `chatState`/`routeFor`:

| Agent is | The message is read |
|---|---|
| running | between two turns: `prepareNextTurn` appends it as a user message before the next request. If the agent has just said `finish` (via the tool) or ended a text-only turn, `finishTurn` returns `continue` so it reads the message before stopping |
| waiting on a gate | when it resumes, as an extra text part next to the gate's outcome |
| queued | in the first prompt, after the work item (static prefix untouched) |
| idle | a new work item (`from: chat`, the message as the task, a short conversation summary as context); the message is marked delivered at once (`via: task`) |

A message is marked delivered only after the turn that carried it ended normally (its content is then in the checkpoint). A failed or cancelled turn leaves it pending, so it is delivered again rather than lost. A message that arrives after the last turn and that nothing else will read (the item has ended and the agent is idle) starts a follow-up run. The runtime rules tell the agent such messages are instructions from the owner of the work, within its policy.

## Invariants: do not break these

1. **Refusal is a tool result, never an exception or a dialog.** Policy denials return text starting with `REFUSED`; tool exceptions return `ERROR: ...`. The loop always continues so the model can change course. This is the reason the runtime does not stall.
2. **Nothing ever blocks waiting for a human.** There are no modal prompts inside the loop. Human input only arrives through gates, which park the item and free the worker.
3. **Deny wins.** Deny rules are checked before allow rules, at `request_approval` time **and again** at execution time. Human approval cannot bypass a deny rule.
4. **Compound commands are checked per segment** (split on `&&`, `||`, `;`, `|`, a single `&`, and newlines; quotes are respected). Command substitution (`$(` and backticks) is always denied. Shell redirection into a protected path, or out of the workspace, is always denied. These hard rejects are applied at `request_approval` and again in `approveAndRun`.
5. **Agents cannot edit their own definitions or the runtime's state.** `.loop/**`, `.github/**` and `.git/**` are protected by default. `.loop/outbox/**` is the only always-writable carve-out, used for drafts.
6. **Secrets never reach the model.** They are injected as env vars at exec time and redacted from every tool result, including `read_file` and values shorter than 4 characters. The child environment is an allowlist plus those secrets, not a copy of `process.env`. The allowlist includes non-secret plumbing (`SSH_AUTH_SOCK`, DBus/XDG runtime, proxy and CA variables) but never tokens such as `GH_TOKEN`; give those to the runtime with Set Secret. Only their names appear in prompts.
7. **The transcript is plain data.** Checkpoints store `PlainMsg[]`; `runner.ts` converts to pi messages when resuming and back at every checkpoint, and to `vscode` classes only per request (pi's own message state is never persisted). Checkpoints must replay byte-identically, which keeps the prompt-cache prefix stable.
8. **Prompt order is static-first.** Order: runtime rules, then role, then skills, then teammates, then the work item. Do not put timestamps or per-run data earlier in the prompt; it breaks prompt caching, which matters under token-based Copilot billing.
9. **One gate per turn.** A second gate call in the same turn returns `Not sent: ...` and creates nothing.
10. **`notifyCommand` is machine-scoped.** A repository must not be able to set it.
11. **`wakeIf` must pass the agent's policy** like any other command.
12. **A human message never blocks and is never lost.** Writing to an agent only writes a file; the worker never waits for it. Delivery is at least once (marked delivered after the turn completes), so an interruption can repeat it but not drop it.

## Data contracts (stable; other files and people depend on these)

### Agent file: `.github/agents/<name>.agent.md`

```yaml
name: sentinel                  # native; defaults to the file name
description: ...                # native; teammates see this in handoff lists
model: ['Claude Sonnet 4.5']    # native; display names, tried in order
handoffs:                       # native; handoff targets = handoffs[].agent
  - { label: ..., agent: techlead, prompt: ... }
loop:                           # Loop Runner only; presence = joins the team
  skills: [harbor-anomaly-detect]
  schedule: "*/15 9-21 * * 1-5" # requires task
  wakeIf: <command>             # requires schedule
  task: <text for scheduled runs>
  model: <copilot family>       # overrides native model for unattended runs
  policy: .loop/policies/x.json
  maxSteps: 15
  maxRunsPerDay: 4              # optional cap on scheduled wakes per local day (>= 1)
```

The body is role instructions shared by Chat mode and unattended mode.

Model resolution order: `loop.model` (by family, no fallback) → native `model` list (by display name; case-insensitive; a ` (copilot)` suffix is ignored) → setting `loopRunner.modelFamily` → first available model.

### wakeIf exit codes

| Exit code | Meaning |
|---|---|
| `0` | Something to handle. Stdout becomes the work-item context. |
| `1` | Nothing to do. |
| other, or timeout | The probe is broken. Alert once; do not wake. |

### State on disk (`.loop/`)

- `queue/<agent>/<id>.json`, `queue/_waiting/`, `queue/_done/`: `WorkItem` (see `queue.ts`)
- `gates/<id>.json`: `Gate` with `kind` (`question` | `approval`), `status`, `resume`, `outcome`, `itemId`
- `checkpoints/<itemId>.json`: `Checkpoint` with `messages`, `turnResults`, `parkedCallId`, `step`. Written when a gate parks the item, and also at the end of every completed turn with `parkedCallId: ''` and `gateId: ''` (no gate result to add). A queued item that has a checkpoint continues from it, so an interrupted or rate-limited run does not repeat its handoffs and writes. `complete()` removes it
- `runs/<date>/<chainId>.jsonl`: audit events; `wake-<date>.jsonl` records wake checks
- `schedule-state.json`: `{ [agent]: "YYYY-MM-DDTHH:MM" }` UTC minute of the last schedule slot that role already handled. Used to catch up one missed `wakeIf` on start
- `chat/<agent>/<id>.json`: one message the human wrote to that agent: `{ id, ts, text, status: pending | delivered, deliveredAt, itemId, via: start | turn | resume | task }`. Written only by the extension on the human's action (`.loop/**` is protected from agents); text is stripped of control characters and capped at 4000 characters
- `outbox/`: drafts written by agents and editable by the human
- `memory/<agent>.md`, `memory/_all.md`: the human's standing notes, one dated bullet per line (max 8000 characters per file). `buildPrompt` puts everyone's notes, then the agent's own, under "Standing instructions from the human" after the static parts and before the work item. Agents cannot write here (`.loop/**` is protected); only an applied `@loop` proposal or the human does. A resumed run keeps the prompt it started with

Audit event `type` values: `start`, `resume`, `model`, `tool`, `park`, `gate`, `notify`, `end`, `error`, `wake`, `retry`, `human` (the agent was given the human's message(s): `via`, `ids`, a clipped `text`). `tool` events may carry `wrote` (files a command left in the outbox). Keep these names stable; a future OTel exporter will map each `chainId` to a trace and each event to a span.

`end` may carry `outputs: string[]`: the workspace-relative files that `write_file` or `edit_file` wrote successfully, from the transcript's tool results (so it holds after a resume). Older chains have no `outputs`; readers fall back to file modification time.

`retry` means the item was left in `queue/<agent>/` instead of `_done`. Reasons: `cancelled` (Stop Team, or the run was cancelled as VS Code closed) and `rate-limit`. The rate-limit path alerts once, pauses the worker, then runs that same item again. Only temporary errors qualify (rate limit, quota, exhausted credits, too many requests, temporarily blocked). `Message exceeds token limit.` is permanent for the item and ends it as `error`. A successful Start Team sets workspaceState `loopRunner.teamStarted` (per workspace, so one workspace's flag never starts or stops another). The next activation starts the team on its own and drains the queue before scheduling. The first start stays a user command so Copilot's consent dialog has a user gesture: the Start Team command itself sends a one-token request with a `justification` to every resolved model that `canSendRequest` does not yet allow, so the consent dialog appears while a person is present (auto-start never does this). If Copilot returns no models yet, start waits up to 2 minutes for `onDidChangeChatModels` once. Reload on a running team re-resolves models. A schedule slot missed while VS Code stayed open (sleep) is caught up once on the next tick. A scheduled wake is skipped while a scheduled item for that agent is queued or parked in `_waiting`. Stop Team clears the flag. Pending gates are announced again on every start, including ones that already have `notifiedAt`.

### Notify

`loopRunner.notifyCommand` receives the event as JSON in `LOOP_EVENT`, plus `LOOP_EVENT_KIND` and `LOOP_EVENT_TITLE`. Kinds: `question`, `approval`, `blocked`, `error`, `max_steps`, `stalled`.

## Defaults worth knowing

| Setting | Value |
|---|---|
| Tick interval | 20 s |
| `commandTimeoutSec` | 180 |
| `maxOutputBytes` | 16000 (tool output keeps head and tail) |
| `maxSteps` | 40 |
| `maxHops` | 5 |
| `maxMinutes` | 30 (wall-clock cap per run; ends as `stalled`) |
| Stall | 3 identical call+result in a row ends the run as `stalled` |
| Nudges when the model calls no tool | 2, then `stalled` |
| Pause after a quota or rate-limit error | 10 min, item stays queued and is retried |
| Notify timeout | 30 s |

Secrets are stored in SecretStorage under `loopRunner.secret.<NAME>`, with the list of names kept in globalState `loopRunner.secretNames`.

## Build, test, package

```bash
npm install
# pi is ESM-only: runner.ts loads it with dynamic import(); tsconfig uses module node20; pins are exact (1.1.0)
npm test          # tsc + test/e2e.js; must print "ALL <n> CHECKS PASSED"
npm run package   # esbuild bundles src into out/extension.js (so `diff` is inside the vsix), then npx @vscode/vsce
```

`test/e2e.js` builds a throwaway workspace from the sample `.github/agents` and `.loop/policies` plus stub skills. It then runs the real runner with a mock `vscode` module and a scripted fake model. Every behaviour change needs a check there, especially anything touching the invariants above.

## Change checklist

- [ ] No new feature (see "Scope is frozen").
- [ ] Modules marked "no" still do not import `vscode` at runtime.
- [ ] Invariants 1 to 11 still hold; add or adjust e2e checks.
- [ ] Data contracts are unchanged, or migrated with both readers updated (`team.ts`, `queue.ts`) and documented here.
- [ ] `npm test` passes.
- [ ] README.md (Chinese, for humans) and this file are updated if behaviour changed.
