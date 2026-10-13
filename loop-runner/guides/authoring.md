# Authoring reference for Loop Runner (for `@loop`)

Loop Runner runs the user's custom agents unattended. It knows nothing about the business: every capability lives in a skill, and every agent is one file. This is how to read, change and create them through the tools you have. The human sees every change as a diff and presses Apply; you never write files yourself.

## How to work

1. Look first: `list_agents` for the team, `get_agent` for one agent's file. Never guess names, goal ids, schedules or skill names.
2. Make the smallest change that does what the human asked, with one propose tool.
3. After proposing, say in one or two sentences what will happen, in plain words, including **when it will run** (cron is in the user's local time). Do not say it is done: it is done only after they press Apply.
4. If a tool answers "Not proposed", read why, fix the input, and try again once. If it cannot be fixed with what you know, tell the human what is missing.

## Which tool for which request

| The human says | Tool |
|---|---|
| change when an agent runs, or what its scheduled task is | `propose_schedule` (the single top-level schedule) |
| give an agent another standing responsibility, change or drop one | `propose_goals` (`op`: add / update / remove) |
| give an agent a skill that already exists in the workspace, or take one away | `propose_skills` |
| write a new skill (instructions and scripts) | `propose_skill`, after `get_authoring_guide` with `topic: "skills"` |
| change how an agent works (its role instructions) | `propose_role_edit` |
| create a new agent | `propose_agent` |
| a lasting rule or preference for an agent | `propose_remember` / `propose_forget` |
| do something once, now | `propose_run` |

You can create a new skill with `propose_skill` (read the skills guide first), but you cannot edit an existing skill or write policy files. If a request needs a policy or a change to an existing skill, say so: the human does it (or an agent in Copilot Chat does, following the reference), and then you can wire it up. A policy goes in `.loop/policies/<name>.json`.

With `propose_goals` update, an empty string clears a field (for example `wakeIf: ""`). Only the goal you name is rewritten; the other goals keep their exact text.

## Creating an agent with `propose_agent`

- Give it a short lowercase name, a one-sentence `description`, and role `instructions` written for an agent that works alone (see "Writing the role instructions" below).
- **Leave out `schedule` and `goals` unless the human asked for automatic runs.** Without them the agent runs only when given a task, so nothing starts by surprise. The proposal card says which case it is; mention it.
- `skills` must already exist. If none fit, create the skill first with `propose_skill`, or create the agent with no skills and tell the human which skill it still needs.
- `policy` must be an existing `.json` file under `.loop/policies/`. Without one the default policy applies.
- `handoffs` must name existing team agents.
- Do not copy another agent's file wholesale. Read it with `get_agent` for tone and structure, and write what this agent is for.

## Mistakes to avoid

- Proposing a skill, policy or agent name you did not see in a tool result.
- Turning on a schedule the human did not ask for, or one more frequent than they said.
- A `schedule` without a `task`, or a `wakeIf` without a `schedule`.
- Putting a business fact in a tool call that the human did not state; ask instead.
- Changing an agent's role instructions to fix a schedule, or the reverse.

<!-- shared reference: the same text is the body of .github/skills/loop-team-authoring/SKILL.md (a test keeps them identical) -->

# Authoring roles and skills for a Loop Runner team

Loop Runner runs VS Code custom agents unattended on Copilot models. It knows nothing about the business: every capability must live in a skill, and every role is a normal VS Code agent file with an extra `loop:` block. Follow these conventions exactly; the runtime depends on them.

## 1. Role file: `.github/agents/<name>.agent.md`

```markdown
---
name: <name>                        # lowercase letters, digits, hyphens; also the queue name and handoff target
description: <one sentence>         # teammates read this when deciding to hand off
model: ['<display name>']           # optional, VS Code model display names
handoffs:                           # optional; only these agents can receive handoffs
  - label: <button text>
    agent: <teammate name>
    prompt: <what the teammate should do>
loop:                               # having this block is what makes it a member of the unattended team
  skills: [<skill>, ...]            # skills it may use; each must exist
  schedule: "<5-field cron>"        # optional; local time. needs task
  task: <what to do when woken>     # required if schedule is set
  wakeIf: <probe command>           # optional; needs schedule
  policy: .loop/policies/<name>.json  # optional; the default policy otherwise
  model: <family>                   # optional model family override, e.g. claude-sonnet-4.5
  maxSteps: <n>                     # steps per run; a whole number >= 1
  maxRunsPerDay: <n>                # scheduled wakes per local day, all outcomes count; a whole number >= 1
  goals: [...]                      # see section 2
---
<role instructions: how the agent works>
```

- An agent without a `loop:` block still works in Copilot Chat but is not part of the unattended team and cannot be handed work or given tasks.
- A handoff target must itself have a `loop:` block, or it cannot receive work unattended. `Reload & Validate Team` reports this case.
- Skills are looked up in `.github/skills`, `.agents/skills`, `.claude/skills` and `.loop/skills`, as `<dir>/<skill>/SKILL.md`.

### Writing the role instructions

The body is used both in Copilot Chat and unattended:

- Name the skills to use. Chat mode does not read `loop.skills`.
- Say "ask the human" when judgement is needed. Unattended, this becomes the `ask_human` gate, which pauses and resumes; never instruct the agent to guess on judgement calls.
- Any action with external effect that a human must sign off (replying to a customer, changing data) must go through approval: write a draft to `.loop/outbox/...`, then request approval with a command that **reads that draft file**. Never embed the text in the command, because the human may edit the draft before approving.
- A teammate receives only the handoff `task` and `context`, never the conversation. Tell the agent to put file paths, ids and evidence into the handoff context.
- Separate observing from concluding when the domain demands it (for example, investigate first, then fix only when evidence is sufficient).

## 2. Goals: one agent, several standing responsibilities

```yaml
loop:
  goals:
    - id: release-health            # lowercase letters, digits, hyphens; unique within the agent
      text: Harbor releases run normally   # what the agent is responsible for (required)
      schedule: "*/15 * * * *"      # cron, local time (optional)
      wakeIf: <command>             # zero-token pre-check; needs schedule (optional)
      task: <what a run does>       # defaults to text
      skills: [extra-skill]         # added for runs of this goal only
      policy: .loop/policies/x.json # overrides the agent's policy for this goal
      urgent: true                  # the human is told as soon as the probe finds something; may use the reserved worker
      maxSilence: 2h                # like 30m or 2h; the human is told if no pre-check ran for this long (needs schedule)
      maxRunsPerDay: 6              # whole number >= 1
```

- The single top-level `schedule`/`task`/`wakeIf` is the goal `default`.
- Schedule state, the daily cap and wake history are kept per goal.
- A goal without a schedule never runs on its own; it only records a responsibility.

## 3. The wakeIf probe (zero-token schedule gate)

A scheduled goal with `wakeIf` costs nothing until there is work. The probe is usually the skill's detection script with an exit-code mode:

| Exit code | Meaning | What happens |
|---|---|---|
| 0 | there is something to handle | the agent wakes; stdout is its context |
| 1 | nothing to do | no model call |
| 2 or anything else, or timeout | the probe itself is broken | the human is told once; the agent does not wake |

A probe that could not get its data (authentication failed, empty response) must exit 2, never 1: 1 means "I looked and all is well". Make the exit-0 output self-sufficient (what, when, values versus target, ids or anchors) so the agent does not need to re-run detection, and write `task` assuming the probe already found something.

## 4. Skill: `.github/skills/<skill-name>/`

A skill is a folder with `SKILL.md` (frontmatter `name`, `description`; body: how and when to use it) and optional `scripts/` and `references/`. Its scripts are pre-approved for every agent that lists the skill and run unattended, so they follow strict conventions: non-interactive, credentials from environment variables, small JSON output, meaningful exit codes, and writes only under `.loop/outbox/`. The full rules and the writing guidance are in the `loop-skill-authoring` skill (`guides/skill-authoring.md`); read it before writing or changing a skill or script.

## 5. Policy: `.loop/policies/<name>.json` (optional)

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

## 6. Giving a role a memory

Every run starts from nothing. If a role should build on what it did before (not reopen something a human chose to watch, say what changed since last time), add the shared skill `loop-memory` (source: `skills/loop-memory/` in the Loop Runner repository; copy it into the workspace's `.github/skills/`) to its `loop.skills`, and give it two lines in the body: start with `now` and `recall --agent <name>`, finish with `note --agent <name>`. Use `check --key <subject> --value <number>` before acting on something that may already be known, and `track` when a subject should be followed or a human has decided about it. The skill's own SKILL.md carries the protocol, so the role file does not repeat it. Do not give a role its own note-taking instructions or file layout.

## 7. Checklist before finishing

- [ ] Role file parses: run "Loop Runner: Reload & Validate Team" and fix every reported problem.
- [ ] Every `loop.skills` entry exists, and the body names the skills for Chat mode.
- [ ] Scheduled roles have a `task`; probes follow the exit-code contract and were run once by hand.
- [ ] External effects go through approval with a draft in `.loop/outbox/`.
- [ ] Scripts are non-interactive, read secrets from the environment, and print small JSON.
- [ ] The policy grants only what the role needs.
