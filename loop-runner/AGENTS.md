# AGENTS.md: guide for AI agents working on Harbor Mate

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
- parallel workers beyond the small pool approved on 2026-10-13 (below)
- built-in notification channels or business integrations

Bug fixes, security fixes and test improvements are welcome. If a change seems to need a new feature, stop and ask the human.

**Approved additions (2026-10-11): the console.** The owner approved a native console on top of the existing surfaces: the status bar line (running agent, step, next wake), the sidebar "Agents" group (state, next run, last wake check, opens the agent file), "Recent runs" with the files each run wrote, and "Open Latest Result" reading `end.outputs`. It stays native (no chat, no notifications). The one data addition is the optional `outputs` field on the `end` audit event. Setup checks and a sample-agent command are not approved yet.

**Approved (2026-10-11): pi as the loop.** The owner decided the basic harness should be pi's `Agent` rather than our own loop. `runItem`'s interface, the checkpoint format and the audit events are unchanged; the e2e suite and the sim pass on it. Tools are executed sequentially. pi validates tool arguments against the schemas (strings such as `"5"` are coerced; a missing required field comes back as a tool error). The loop is vendored (`src/vendor/pi-agent/`), so the extension's only runtime dependency is `diff`: none of pi's model-provider SDKs are installed.

**Approved (2026-10-11): `@mate` in the Chat window and standing notes.** The owner asked to steer agents by conversation. `@mate` (`/status`, `/pending`, or free text) uses the model picked in Chat. It reads team state with tools and can only *propose* changes (schedule, task text, role edit, standing note, one-off task, answer a question, start/stop); the user sees the diff and presses Apply, and `applyChange` refuses a file that changed since it was proposed. Approvals are never decided in chat: they stay in the console, where the exact command and files are shown. Role and schedule edits write `.github/agents/*.agent.md` on the human's click, which is the only path by which those files change (invariant 5 still binds the agents themselves).

**Approved (2026-10-12): chat with each agent**, laid out like the Grok Bot agent roster (a messaging-app roster with a face and a progress line per agent, state carried by motion on the face, the conversation beside it, a rounded composer; `@name` writes to another agent, `/stop` ends the current run). The console opens on a Chat tab: one conversation per team agent, and the Overview tab keeps everything else (needs-you, agents, runs). The human can write to an agent that is **working, waiting for them, queued or idle**; the message reaches it at the next opportunity (see "Messages from the human" below). Questions and approvals appear inside the conversation and are answered there; approvals still show the exact command and the files and are bound to their hashes. **Cancel this run** ends the current run as `cancelled` (not retried, unlike Stop Team). The agent's side of the conversation is not stored again: it is read from the audit files.

**Approved additions (2026-10-11), second batch:** approval bound to what the reviewer saw (the console shows each draft file and sends its sha256; `approveAndRun` refuses if a file changed since or was never shown), run guardrails (stalled after 3 identical results, `harborMate.maxMinutes`), and the optional `loop.maxRunsPerDay`. A capped wake is recorded as a `wake` audit event with `wake:false, capped:<n>`.

**Approved addition (2026-10-11): the Harbor Mate Console webview.** After the owner found the native surfaces too hard to read, a single webview page (`Harbor Mate: Open Console`, also the status bar item) shows what needs you (answer, approve with the exact command shown, reject), the agents, and a step timeline with output files for each recent run. It only reads `.loop/` and calls the existing gate functions; no new data contract, no new runtime behaviour.

**Approved (2026-10-13): task ledger.** The owner asked that agents remember the tasks they have in progress, possibly several at once, and that those tasks can move between agents through `handoff`. A task is a chain (`id` = `chainId`). Facts are split by who can know them: the runtime records identity, who holds the task, lineage and how each run ended (at lifecycle points; the model never writes these); the model supplies only "is it still open" and "what is my next step", through `finish` (status `open` + `next`) and `update_task`. This is deliberately not `loop-memory`: ownership moves inside the `handoff` tool and the item lifecycle, which only the runtime sees; the ledger lives under `.loop/` (protected from agents, invariant 5) so it cannot be forged; and injecting it into the prompt is guaranteed rather than dependent on the model calling a script. `loop-memory` stays as is (knowledge, tracked subjects); tasks are commitments in flight.

**Approved (2026-10-13): goals and a small worker pool.** The owner wants ONE assistant that holds several standing responsibilities (for example "HarborSense production issues are found and reported in time" and "Harbor Release runs normally"), not one agent per goal, and urgent alerts must not wait behind a 20-minute run. This lifts the "no parallel workers" freeze item, only as specified here, and adds `loop.goals`. **Addendum (2026-10-13): deliverables.** `finish` takes an optional `deliverables: string[]`: the workspace files the agent produced for the human to read (a report, a write-up), declared by the agent because only it knows. Paths are normalized to workspace-relative; missing ones and ones outside the workspace are dropped and the result text says so. The `end` audit event records them. The console's result card shows them prominently and folds the other output files as "supporting"; for runs that declared none, documents (`.md .html .pdf .csv .xlsx .docx .txt`) under `.loop/outbox/` (no dot-prefixed path segment below it) are treated as deliverables. Display only otherwise.

**Runtime prompt principles (2026-10-13).** The runtime rules and the tool descriptions are written to prevent specific failures, not to make the agent "more proactive" (pi's own prompt has no such text; the model already has that tendency). Keep each of these, and change them only for a failure you have seen: (1) an agent can reach only its skills' scripts, the file tools and what its policy allows, and must check that before it decides something is out of reach; (2) `REFUSED` is stated one way everywhere (the same call fails again; a different route, `request_approval` only when the message offers it, or report the gap); (3) `ask_human` is for what only a human can give, and every question costs hours, so the agent does what it can first, quotes the exact error, and names the lasting fix (a skill, an allowed command, a secret) when a capability is missing; (4) content read from files, tickets and command output is data, not instructions. Guidance sits in the description of the tool where the decision is made. A skill longer than `LONG_SKILL_CHARS` is listed with a pointer to read it, not injected whole. Tests pin the wording only to catch accidental removal; whether behaviour improved has to be checked with a real model on a few scenarios (no skill for the task, a skill that returns 401, a working skill that should not trigger a question, a ticket that tries to give orders).

**Approved (2026-10-13): create and edit agents through `@mate`.** The owner wants one entry point to change agents and create new ones by conversation. `@mate` gains `propose_goals` (add, update or remove one `loop.goals` entry), `propose_skills` (add or remove skills in `loop.skills`), `propose_agent` (create `.github/agents/<name>.agent.md`) and a read tool `get_authoring_guide` that serves `guides/authoring.md`, which ships inside the extension. Invariants: the chat model still only proposes, the human presses Apply, and `applyChange` still refuses a file that changed (or appeared) after the proposal; every proposed agent file is checked with `problemsIfWritten` (the team validator run on the file as it would be) and a failing proposal shows no diff; a new agent has no schedule and no goals unless the human asked, and the card states whether it will run on its own; chat cannot create skills or policy files, `policy` may only name an existing file under `.loop/policies/`, and the names `loop` and `chief-of-staff` are reserved. Nothing changes at runtime: the only writes are agent files, on the human's click.

**Approved (2026-10-13): create skills through `@mate` (`propose_skill`).** The owner wants skills for agents to be written to the runtime's conventions automatically. `propose_skill` creates `.github/skills/<name>/` (SKILL.md, `scripts/`, `references/`) on the human's click and never overwrites or edits an existing skill; `get_authoring_guide` takes `topic: "skills"`. The security point is that a skill's scripts are pre-approved for every agent that lists it and are not checked by policy, so the code is the trust boundary: the proposal card shows every file in full and says so, `lintSkill` refuses what is plainly wrong (prompts for input, pasted secrets, scripts that mention agent definitions or runtime state, bad names or paths, oversize files, duplicate names) and lists the rest as warnings (network use, shell strings built from text, files the instructions never mention, a description that says nothing about when to use the skill). Apply is all-or-nothing and takes back what it wrote if a later file fails. `guides/skill-authoring.md` and the `loop-skill-authoring` skill carry the same text, kept identical by a test. **Addendum (2026-10-13): edit skills, and a design review.** `propose_skill_edit` changes an existing skill under `.github/skills` (description, instructions, scripts, references; edit one occurrence, replace or add a file, delete a file) after `get_skill` shows its files and the agents that use it; the card names those agents because the change reaches their next unattended run, only changed scripts are linted, the shipped skills and skills outside `.github/skills` are refused, and Apply is all-or-nothing with rollback. `designWarnings` adds a non-blocking "Design review" to agent proposals (short instructions, unnamed skills, scheduled without a `wakeIf` probe, more often than every 5 minutes, no `maxRunsPerDay`, too many skills, goals or handoffs, judgement left to the model, outside effects with no mention of approval). The principles and anti-patterns behind it are section 7 of `guides/authoring.md`, kept identical to `loop-team-authoring` by a test.

Out of scope until asked: per-goal secret scoping, daily handover, escalation, per-agent concurrency limits, per-card messaging or reassignment.

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
| `exec.ts` | Harbor Mate shell wrapper: allowlisted env, secret injection, redaction, output cap (keeps the first and the real last `cap/2` chars). Process spawn/kill is pi's | no |
| `vendor/pi/` | Vendored pi tool implementations (bash, read, write, edit, ls, find, grep). No TUI | no |
| `queue.ts` | File-backed state: work items, gates, checkpoints, audit | no |
| `wake.ts` | `checkWake`: runs `loop.wakeIf` and interprets its exit code | no |
| `gates.ts` | Resolve gates (answer, approve-and-run, reject) and `notify` | no |
| `tools.ts` | Generic tool schemas and `runTool` | types only (elided) |
| `runner.ts` | One work item on pi's `Agent` loop, vendored in `src/vendor/pi-agent/` (no npm dependency): `streamFn` over `vscode.lm`, tools via `runTool`, `finishTurn` for park, finish, caps and checkpoints. Converts between pi messages and `PlainMsg` | yes |
| `inbox.ts` | Sidebar tree view and gate rendering | yes |
| `outbox.ts` | `latestOutput`: newest file under `.loop/outbox/` (fallback for Open Latest Result). Pure, no `vscode` | no |
| `runs.ts` | `recentRuns` and `outputsFrom`: read-only summaries of `.loop/runs/*.jsonl`. Pure, no `vscode` | no |
| `status.ts` | `agentRows` and `nextWake`: team state, next scheduled wake, last wake check. Pure, no `vscode` | no |
| `thread.ts` | `glance` (one agent's roster row: state, avatar state, progress line), the human's messages (`postHumanMessage`, `pendingMessages`, `markDelivered`), `buildThread` (the conversation with one agent, from those messages plus the audit), `chatState`, `routeFor`, `conversationContext`. Pure, no `vscode` | no |
| `tasks.ts` | The task ledger (`.loop/tasks/<chainId>.json`): `taskOnStart`, `taskOnHandoff`, `taskOnEnd` (also decides and enqueues the return wake), `updateTask`, `closeTaskByHuman`, `openTasksFor`, `getTask`, `listTasks`. Tolerates missing or corrupt files; never throws into a run. Pure, no `vscode` | no |
| `goals.ts` | Scheduling per goal: `goalsDue`, `fireGoal` (wake check, daily cap, the alert for an urgent probe, enqueue), `lastCheck`, `checkSilence`. Pure over an I/O object, no `vscode` | no |
| `textutil.ts` | `clip`, `firstLine`, `brief`. Pure | no |
| `console.ts` | `consoleModel`, `stepsOf`, `renderBody`/`renderPage`: the console's data and HTML (every value escaped, one nonce script). Pure, no `vscode` | no |
| `consoleView.ts` | Webview panel host: forwards page actions to the existing commands and gate functions; opens only files inside the workspace | yes |
| `manage.ts` | `Change` for a schedule, task, role edit or memory note (`proposeSchedule`, `proposeRoleEdit`, `proposeRemember`, `proposeForget`), `diffOf`, `applyChange`, `memoryFor`. Patches single lines of the `loop:` block; nothing is written until `applyChange` | no |
| `chatTools.ts` | The tools behind `@mate`: reads answer at once, every `propose_*` returns a Proposal (title, diff, `apply`). Pure over a small host interface | no |
| `chat.ts` | The `@mate` chat participant: model tool loop, Apply and Dismiss buttons | yes |
| `extension.ts` | Glue: `TeamService` (tick, schedule, the worker pool), commands, notifications, secrets | yes |

**Rule:** keep `vscode` out of every module marked "no". The test suite loads those modules without VS Code; `runner.ts` is tested through a mock `vscode` module.

## Lifecycle of a work item

1. **Trigger.** Every 20 s `TeamService.tick()` checks each goal's `schedule` (`goals.ts`; the agent's legacy single `schedule` is the goal `default`). When due, `checkWake` runs the goal's `wakeIf`. For an `urgent` goal whose probe exits 0, the human is notified first (kind `alert`) and only then is the item enqueued with `urgent: true`. **An urgent goal's probe keeps running while its previous item is still open** (queued or parked on a gate, for example overnight on `ask_human`): if it wakes, the `alert` is sent again unless its output is identical to the last alert for that goal (kept in memory), and no second item is enqueued (the daily cap likewise limits runs, not probes). So an urgent goal's `wakeIf` must be idempotent: it must not consume events. For other goals, a wake skipped because an item is open writes the `wake` audit event `{ wake: false, open: true }`, which `lastCheck` counts as a check, so `maxSilence` does not fire while the goal is being handled. A goal with `maxSilence` that has had no wake check that ran (exit 0 or 1) for that long is announced once (kind `goal_silent`) and the mark resets when a check runs again; this is also evaluated on start. Exit 0 enqueues an item whose context is the probe's stdout. Exit 1 does nothing (no model call). Any other exit is alerted once, until it recovers. A manual task from the "Give an Agent a Task" command is enqueued directly.
2. **Queue.** `pickItem`/`nextItem` (queue.ts) choose what starts next. Setting `harborMate.workers` (default 2, min 1) is the pool size. Rules: an item whose `chainId` already has a running item never starts (so a handoff waits for its sender to end); with more than one worker non-urgent items may fill at most `workers - 1` slots, so one slot stays free for `urgent` items (with the default 2: one normal run and one urgent run at a time; use 3 or more for two normal runs together); among the eligible, urgent first, then oldest first. With `workers: 1` and no urgent items this is plain FIFO. A rate-limit pause pauses the whole pool. Stop Team and Cancel this run act per running item. Several runs of one agent may be live; the human's messages go to its earliest-started run (`RunDeps.takesMessages`). The simulation always runs one worker.
3. **Run.** `runItem` builds the prompt, or rebuilds it from a checkpoint, and loops: `sendRequest(toolMode=Auto)` (Copilot rejects Required with more than one tool, inside the response stream, so there is no Required attempt and no fallback), then execute tool calls in order, then feed results back. It stops on `finish`, `maxSteps`, cancellation, model error, or a gate.
4. **Outcomes.**
   - `handoff` enqueues an item for a teammate with the same `chainId` and `hop+1`.
   - A gate saves a checkpoint and returns `waiting`; the item moves to `queue/_waiting`.
   - `finish` completes the item. `finish` with status `open` (needs `next`) means the task is not finished and stays on the agent's list.
   **Task ledger.** Alongside these, `runItem` writes `.loop/tasks/<chainId>.json`: the file is created lazily, only once a task outlives a single run: by the first `handoff`, or by a run that ends in any status other than `done`/`nothing_to_do` (a scheduled run that finds nothing leaves no file). A fresh run of an existing task adds the agent as holder; `handoff` adds the receiver to the holders; every terminal status (errors included, but not `waiting`, `cancelled` or a rate-limit retry, where the item is still live) is recorded by `taskOnEnd`: `done`/`nothing_to_do` remove the agent as holder, `open` keeps it with `next[agent]`, `blocked`/`max_steps`/`stalled`/`error` keep it with the summary as its next step. The human's "Cancel this run" (the item is dropped, not retried) is recorded like `blocked` (`next` = "cancelled by the human", end logged as `cancelled`); a `cancelled` item that will be retried changes nothing. No holders left means state `done`. **Return wake:** when an agent ends `done`/`nothing_to_do` and another holder last said `open`, has no queued or waiting item in the chain, and no other holder has a live item, one item is enqueued for it (`from: 'task'`, same `chainId`, `hop+1`, within `maxHops`; if the hop budget is exhausted it is not enqueued and the task log and a `notify` audit event with `kind: 'task'` say so). If several holders qualify, the first in `holders` order is woken. A fresh prompt lists the agent's open tasks (not the current chain) under "Your open tasks" and, for a chain with history (hop > 0 or a return wake), the last 6 log lines under "Task history".
5. **Human.** The human resolves the gate in the Harbor Mate Inbox. `gates.ts` writes `gate.outcome`, and `wake()` moves the item back to its queue with `resumeGate` set.
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
13. **The ledger is written only by the runtime and the human.** Agents change it only through `finish` and `update_task` for tasks they hold, and a ledger problem never fails a run.

## Data contracts (stable; other files and people depend on these)

### Agent file: `.github/agents/<name>.agent.md`

```yaml
name: sentinel                  # native; defaults to the file name
description: ...                # native; teammates see this in handoff lists
model: ['Claude Sonnet 4.5']    # native; display names, tried in order
handoffs:                       # native; handoff targets = handoffs[].agent
  - { label: ..., agent: techlead, prompt: ... }
loop:                           # Harbor Mate only; presence = joins the team
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

Model resolution order: `loop.model` (by family, no fallback) → native `model` list (by display name; case-insensitive; a ` (copilot)` suffix is ignored) → setting `harborMate.modelFamily` → first available model.

### Goals: `loop.goals`

```yaml
loop:
  goals:
    - id: harborsense            # [a-z0-9-]+, unique within the agent; "default" is the legacy single schedule
      text: HarborSense production issues are found and reported in time
      schedule: "*/15 * * * *"
      wakeIf: <command>          # optional, same contract as below
      task: <text for the run>   # defaults to text
      skills: [harbor-anomaly-detect]   # added to the agent's skills for runs of this goal only
      policy: .loop/policies/x.json     # overrides the agent policy for runs of this goal (also for its approvals)
      urgent: true               # optional
      maxSilence: 2h             # optional: Nm / Nh
      maxRunsPerDay: 6           # optional, per goal
```

The agent's single `schedule`/`wakeIf`/`task`/`maxRunsPerDay` still works and is read as one goal with id `default` (its schedule-state key stays the plain agent name; other goals use `agent#goal`). Scheduling state, catch-up, the "a scheduled item is still open" rule, the daily cap and the `wake` audit events (which now carry `goal`) are all per goal. `WorkItem` gains optional `goal` and `urgent` (handoffs and return wakes inherit `urgent`); `Gate` gains `goal`; a task created by a goal run records `goal`. The prompt lists the agent's responsibilities (`id: text`, only when it has explicit goals) after the role and before the skills, and the work item header names the triggering goal; only that goal's extra skills are expanded (invariant 8 holds: nothing per-run precedes the work item).

### wakeIf exit codes

| Exit code | Meaning |
|---|---|
| `0` | Something to handle. Stdout becomes the work-item context. |
| `1` | Nothing to do. |
| other, or timeout | The probe is broken. Alert once; do not wake. |

**Probe convention:** a probe that got no data (authentication failure, empty or unparseable response) must exit `2`, not `1`. Exit `1` means "I looked and all is clear"; a probe that could not look must be reported as broken, never as clear.

### State on disk (`.loop/`)

- `queue/<agent>/<id>.json`, `queue/_waiting/`, `queue/_done/`: `WorkItem` (see `queue.ts`)
- `gates/<id>.json`: `Gate` with `kind` (`question` | `approval`), `status`, `resume`, `outcome`, `itemId`
- `checkpoints/<itemId>.json`: `Checkpoint` with `messages`, `turnResults`, `parkedCallId`, `step`. Written when a gate parks the item, and also at the end of every completed turn with `parkedCallId: ''` and `gateId: ''` (no gate result to add). A queued item that has a checkpoint continues from it, so an interrupted or rate-limited run does not repeat its handoffs and writes. `complete()` removes it
- `runs/<date>/<chainId>.jsonl`: audit events; `wake-<date>.jsonl` records wake checks
- `schedule-state.json`: `{ [agent]: "YYYY-MM-DDTHH:MM" }` UTC minute of the last schedule slot that role already handled. Used to catch up one missed `wakeIf` on start
- `chat/<agent>/<id>.json`: one message the human wrote to that agent: `{ id, ts, text, status: pending | delivered, deliveredAt, itemId, via: start | turn | resume | task }`. Written only by the extension on the human's action (`.loop/**` is protected from agents); text is stripped of control characters and capped at 4000 characters
- `outbox/`: drafts written by agents and editable by the human
- `tasks/<chainId>.json`: `Task` (see `tasks.ts`): `{ id, title, state: open | done | dropped, holders[], next?: { [agent]: text }, createdAt, updatedAt, log[] }`, the log capped at 30 entries of `{ ts, agent, event: start | handoff | end | update | human, status?, to?, text? }`. Written by the runtime at lifecycle points, by `update_task`, and by the human's Close in the console (`event: human`, state `dropped`). Runtime notes (return wake queued or skipped) are log `update` entries by agent `task`. Agents cannot write here (`.loop/**` is protected)
- `ui-state.json`: `{ dismissed: ["<agent>\n<command>"], flags: ["approvalNoteSeen"] }`: what the console has been told to stop showing (a dismissed blocked command, the one-time note on the first approval card). Written by the console on the human's click (`maintenance.ts`, like `paused.json`); agents cannot write here (`.loop/**` is protected). A refused command is a to-do (counted with questions and approvals) only while the mate's newest run ended `blocked` on `no allow rule matched`, the policy still refuses it and it is not dismissed
- `memory/<agent>.md`, `memory/_all.md`: the human's standing notes, one dated bullet per line (max 8000 characters per file). `buildPrompt` puts everyone's notes, then the agent's own, under "Standing instructions from the human" after the static parts and before the work item. Agents cannot write here (`.loop/**` is protected); only an applied `@mate` proposal or the human does. A resumed run keeps the prompt it started with

`WorkItem.from` is `schedule`, `user`, `chat`, an agent name (handoff), or `task` (a return wake).

Tool `finish` statuses: `done`, `blocked`, `nothing_to_do`, `open` (requires `next`; without it the tool returns an error text and the run continues). `update_task { id, state: open | done | dropped, note }` changes a task the agent holds (refused with `REFUSED...` if it is not a holder or the task is not open).

Audit event `type` values: `start`, `resume`, `model`, `tool`, `park`, `gate`, `notify`, `end`, `error`, `wake`, `retry`, `human` (the agent was given the human's message(s): `via`, `ids`, a clipped `text`). `tool` events may carry `wrote` (files a command left in the outbox). Keep these names stable; a future OTel exporter will map each `chainId` to a trace and each event to a span.

`end` may carry `outputs: string[]`: the workspace-relative files that `write_file` or `edit_file` wrote successfully, from the transcript's tool results (so it holds after a resume). Older chains have no `outputs`; readers fall back to file modification time.

`retry` means the item was left in `queue/<agent>/` instead of `_done`. Reasons: `cancelled` (Stop Team, or the run was cancelled as VS Code closed) and `rate-limit`. The rate-limit path alerts once, pauses the worker, then runs that same item again. Only temporary errors qualify (rate limit, quota, exhausted credits, too many requests, temporarily blocked). `Message exceeds token limit.` is permanent for the item and ends it as `error`. A successful Start Team sets workspaceState `harborMate.teamStarted` (per workspace, so one workspace's flag never starts or stops another). The next activation starts the team on its own and drains the queue before scheduling. The first start stays a user command so Copilot's consent dialog has a user gesture: the Start Team command itself sends a one-token request with a `justification` to every resolved model that `canSendRequest` does not yet allow, so the consent dialog appears while a person is present (auto-start never does this). If Copilot returns no models yet, start waits up to 2 minutes for `onDidChangeChatModels` once. Reload on a running team re-resolves models. A schedule slot missed while VS Code stayed open (sleep) is caught up once on the next tick. A scheduled wake is skipped while a scheduled item for that agent is queued or parked in `_waiting`. Stop Team clears the flag. Pending gates are announced again on every start, including ones that already have `notifiedAt`.

### Notify

`harborMate.notifyCommand` receives the event as JSON in `LOOP_EVENT`, plus `LOOP_EVENT_KIND` and `LOOP_EVENT_TITLE`. Kinds: `question`, `approval`, `blocked`, `error`, `max_steps`, `stalled`, `alert` (an urgent goal's probe found something; sent before the run is queued), `goal_silent`.

## Defaults worth knowing

| Setting | Value |
|---|---|
| Tick interval | 20 s |
| `commandTimeoutSec` | 180 |
| `maxOutputBytes` | 16000 (tool output keeps head and tail) |
| `workers` | 2 (one slot reserved for urgent items) |
| `maxSteps` | 40 |
| `maxHops` | 5 |
| `maxMinutes` | 30 (wall-clock cap per run; ends as `stalled`) |
| Stall | 3 identical call+result in a row ends the run as `stalled` |
| Nudges when the model calls no tool | 2, then `stalled` |
| Pause after a quota or rate-limit error | 10 min, item stays queued and is retried |
| Notify timeout | 30 s |

Secrets are stored in SecretStorage under `harborMate.secret.<NAME>`, with the list of names kept in globalState `harborMate.secretNames`.

## Build, test, package

```bash
npm install
npm test          # tsc + test/e2e.js; must print "ALL <n> CHECKS PASSED"
npm run package   # esbuild bundles src into out/extension.js (so `diff` is inside the vsix), then npx @vscode/vsce
```

`test/e2e.js` builds a throwaway workspace from the sample `.github/agents` and `.loop/policies` plus stub skills. It then runs the real runner with a mock `vscode` module and a scripted fake model. Every behaviour change needs a check there, especially anything touching the invariants above.

## Change checklist

- [ ] No new feature (see "Scope is frozen").
- [ ] Modules marked "no" still do not import `vscode` at runtime.
- [ ] Invariants 1 to 13 still hold; add or adjust e2e checks.
- [ ] Data contracts are unchanged, or migrated with both readers updated (`team.ts`, `queue.ts`) and documented here.
- [ ] `npm test` passes.
- [ ] README.md (Chinese, for humans) and this file are updated if behaviour changed.
