---
name: loop-team-authoring
description: Create or modify roles (.github/agents/*.agent.md) and skills that run unattended under Loop Runner, the VS Code extension that schedules Copilot agents. Use when asked to add a team member, give an agent a schedule, write a wakeIf probe, or write a skill script an agent will run.
---

# Authoring roles and skills for a Loop Runner team

Loop Runner runs VS Code custom agents unattended on Copilot models. It knows nothing about the business: every capability must live in a skill, and every role is a normal VS Code agent file with an extra `loop:` block. Follow these conventions exactly; the runtime depends on them.

## 1. Role file: `.github/agents/<name>.agent.md`

```markdown
---
name: <name>                         # lowercase, used as queue name and handoff target
description: <one sentence>          # teammates read this when deciding to hand off
model: ['<display name>']            # optional, native VS Code field
handoffs:                            # native; only these agents can receive handoffs
  - label: <button text>
    agent: <teammate name>
    prompt: <what the teammate should do>
loop:                                # presence of this block = joins the unattended team
  skills: [<skill-name>, ...]        # exact skill folder or frontmatter names
  schedule: "<5-field cron>"         # optional; machine local time
  wakeIf: <probe command>            # optional; requires schedule (see section 3)
  task: <what to do when woken>      # required if schedule is set
  policy: .loop/policies/<name>.json # optional
  maxSteps: <n>
---
<role instructions>
```

Rules for the body (it is used both in Copilot Chat and unattended):

- Name the skills to use. Chat mode does not read `loop.skills`.
- Say "ask the human" when judgement is needed. Unattended, this becomes the `ask_human` gate, which pauses and resumes; never instruct the agent to guess on judgement calls.
- Any action with external effect that a human must sign off (replying to a customer, changing data) must go through approval: write a draft to `.loop/outbox/...`, then request approval with a command that **reads that draft file**. Never embed the text in the command, because the human may edit the draft before approving.
- A teammate receives only the handoff `task` and `context`, never the conversation. Tell the agent to put file paths, ids and evidence into the handoff context.
- Separate observing from concluding when the domain demands it (for example, investigate first, then fix only when evidence is sufficient).

A target in `handoffs` that has no `loop:` block works in Chat but cannot receive work unattended. `Reload & Validate Team` reports this case.

## 2. Skill: `.github/skills/<skill-name>/`

```
SKILL.md        frontmatter: name, description; body: when and how to use it
scripts/        executables the agent runs; pre-approved for agents that list this skill
```

Script conventions (required, because commands run with stdin closed and a hard timeout, default 180 s):

- **Non-interactive.** Never prompt, never open a pager, never wait for input.
- **Credentials come from environment variables** (for example `HARBOR_PAT`, `JIRA_TOKEN`). The human stores them with "Loop Runner: Set Secret". Never print them; the runtime also redacts them.
- **Print machine-readable output** (JSON preferred) and keep it small. Output beyond about 16 KB is truncated to its head and tail.
- **Exit codes are meaningful:** 0 means success; non-zero means failure, with the reason on stderr.
- Call scripts as `python3 .github/skills/<skill>/scripts/x.py ...` (or `python`, `py`, `node`, `bash`, `sh`, `pwsh`, `powershell`). Use forward slashes; they work on Windows too. Only paths inside `scripts/` of the agent's own skills are pre-approved.
- Do not call `curl`, `wget`, `ssh` or similar directly from the agent. They are denied by default; network access belongs inside skill scripts.
- Mask or aggregate sensitive business data inside the script before printing. Whatever a script prints is sent to the model.
- Scripts that send or publish something must take the draft file path as an argument.

## 3. wakeIf probe (zero-token schedule gate)

A scheduled agent with `wakeIf` costs nothing until there is work. The probe is usually the skill's detection script with an exit-code mode:

| Exit | Meaning | Runtime action |
|---|---|---|
| 0 | there is something to handle | wake the agent; stdout becomes its context |
| 1 | nothing to do | no model call |
| other or timeout | the probe itself is broken | alert the human once; do not wake |

Make the exit-0 output self-sufficient (what, when, values versus target, ids or anchors) so the agent does not need to re-run detection. Write the role's `loop.task` assuming the probe already found something.

## 4. Policy: `.loop/policies/<name>.json` (optional)

```json
{
  "allowCommands": ["^regex for allowed command segments"],
  "denyCommands":  ["regex; checked first; also blocks human-approved commands"],
  "writablePaths": ["glob/**"],
  "protectedPaths": [".loop/**", "**/.github/**", "**/*.env"],
  "commandTimeoutSec": 180,
  "maxOutputBytes": 16000
}
```

- Give each role the least it needs. Read-only roles get `"writablePaths": []`.
- Skill scripts do not need allow rules.
- `.loop/outbox/**` is always writable for drafts.
- Example: if a role pushes code, allow only `push origin agent/...` and deny every other push and force push.

## 5. Checklist before finishing

- [ ] Role file parses: run "Loop Runner: Reload & Validate Team" and fix every reported problem.
- [ ] Every `loop.skills` entry exists, and the body names the skills for Chat mode.
- [ ] Scheduled roles have a `task`; probes follow the exit-code contract and were run once by hand.
- [ ] External effects go through approval with a draft in `.loop/outbox/`.
- [ ] Scripts are non-interactive, read secrets from the environment, and print small JSON.
- [ ] The policy grants only what the role needs.

## 6. Giving a role a memory

Every run starts from nothing. If a role should build on what it did before (not reopen something a human chose to watch, say what changed since last time), add the shared skill `loop-memory` (source: `skills/loop-memory/` in the Loop Runner repository; copy it into the workspace's `.github/skills/`) to its `loop.skills`, and give it two lines in the body: start with `now` and `recall --agent <name>`, finish with `note --agent <name>`. Use `check --key <subject> --value <number>` before acting on something that may already be known, and `track` when a subject should be followed or a human has decided about it. The skill's own SKILL.md carries the protocol, so the role file does not repeat it. Do not give a role its own note-taking instructions or file layout.
