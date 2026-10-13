# Authoring reference for Harbor Mate (for `@mate`)

Harbor Mate runs the user's custom agents unattended. It knows nothing about the business: every capability lives in a skill, and every agent is one file. This is how to read, change and create them through the tools you have. The human sees every change as a diff and presses Apply; you never write files yourself.

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
| change an existing skill | `get_skill`, then `propose_skill_edit` |
| only wake it when something happens (a probe) | write the probe with `propose_skill`, then `propose_schedule` or `propose_goals` with `wakeIf` (see "Writing a probe for the human") |
| change how an agent works (its role instructions) | `propose_role_edit` |
| create a new agent | `propose_agent` |
| a lasting rule or preference for an agent | `propose_remember` / `propose_forget` |
| do something once, now | `propose_run` |

You can create a skill with `propose_skill` and change one with `propose_skill_edit` (read the skills guide first), but you cannot write policy files. If a request needs a policy, say so: the human writes it, and then you can wire it up. A policy goes in `.loop/policies/<name>.json`.

With `propose_goals` update, an empty string clears a field (for example `wakeIf: ""`). Only the goal you name is rewritten; the other goals keep their exact text.

## Writing a probe for the human

A `wakeIf` probe is a small script that answers "is there anything to do?" without a model call. The human says it in plain words ("only wake it when there is a new failed deploy"); you write the script. Do not suggest a probe for a daily or weekly schedule, and do not push one: it is optional.

1. Ask what the data source is and which command or API gives it, unless you were told. Never invent a command-line tool.
2. Create the probe as a skill script with `propose_skill` (read the skills guide first; it has a skeleton). It must exit 0 when there is work (and print what, briefly), 1 when there is nothing, 2 when it could not check.
3. The probe must be in a skill the agent lists, so add the skill with `propose_skills` if the agent does not have it yet.
4. Set it with `propose_schedule` (`wakeIf`) for the agent's single schedule, or `propose_goals` for a goal. The command is `python3 .github/skills/<skill>/scripts/check.py`.
5. Tell the human to run the script once by hand (section 6 of the skills guide) before relying on it.

## Creating an agent with `propose_agent`

- Give it a short lowercase name, a one-sentence `description`, and role `instructions` written for an agent that works alone (see "Writing the role instructions" below).
- **Leave out `schedule` and `goals` unless the human asked for automatic runs.** Without them the agent runs only when given a task, so nothing starts by surprise. The proposal card says which case it is; mention it.
- `skills` must already exist. If none fit, create the skill first with `propose_skill`, or create the agent with no skills and tell the human which skill it still needs.
- `policy` must be an existing `.json` file under `.loop/policies/`. Without one the default policy applies.
- `handoffs` must name existing team agents.
- The card ends with a **Design review** of judgement calls (no probe on a schedule, a very short prompt, a skill the instructions never name, actions with outside effects but no approval, too many skills or goals, and so on). Fix what you can by proposing again, and tell the human about the rest in a sentence. Work from the principles in section 7 of the reference below when you write the instructions: decision rules, what never to do, when to ask the human, how to finish.
- Do not copy another agent's file wholesale. Read it with `get_agent` for tone and structure, and write what this agent is for.

## Mistakes to avoid

- Proposing a skill, policy or agent name you did not see in a tool result.
- Turning on a schedule the human did not ask for, or one more frequent than they said.
- A `schedule` without a `task`, or a `wakeIf` without a `schedule`.
- Putting a business fact in a tool call that the human did not state; ask instead.
- Changing an agent's role instructions to fix a schedule, or the reverse.

<!-- shared reference: the same text is the body of .github/skills/loop-team-authoring/SKILL.md (a test keeps them identical) -->

# Authoring roles and skills for a Harbor Mate team

Harbor Mate runs VS Code custom agents unattended on Copilot models. It knows nothing about the business: every capability must live in a skill, and every role is a normal VS Code agent file with an extra `loop:` block. Follow these conventions exactly; the runtime depends on them.

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

## 3. The wakeIf probe (optional zero-token gate)

Optional. Worth it when a goal runs more than once an hour and most runs would find nothing; a daily report does not need one. A scheduled goal with `wakeIf` costs nothing until there is work. The probe is a script in a skill the agent lists (the command passes the agent's policy like any other), usually the skill's detection script with an exit-code mode:

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

Every run starts from nothing. If a role should build on what it did before (not reopen something a human chose to watch, say what changed since last time), add the shared skill `loop-memory` (source: `skills/loop-memory/` in the Harbor Mate repository; copy it into the workspace's `.github/skills/`) to its `loop.skills`, and give it two lines in the body: start with `now` and `recall --agent <name>`, finish with `note --agent <name>`. Use `check --key <subject> --value <number>` before acting on something that may already be known, and `track` when a subject should be followed or a human has decided about it. The skill's own SKILL.md carries the protocol, so the role file does not repeat it. Do not give a role its own note-taking instructions or file layout.

## 7. Designing an effective agent

An unattended agent starts every run knowing nothing, cannot ask a colleague, and is paid for by the model call. Design for that.

### Principles

1. **One role, one owner.** An agent is a role with a clear area of responsibility. Several standing responsibilities of the *same* role are goals of one agent. Split into separate agents when the **permissions or the trust level of the data** differ (one reads untrusted input and has narrow rights; another writes), because the policy is per agent.
2. **Least privilege.** Give each agent its own policy with only the commands and paths it needs; read-only roles get `"writablePaths": []`. Give it only the skills it uses, and credentials only to the skills that need them. Loosen a policy only for an agent that reads nothing written by outsiders.
3. **Cheap first.** Let scripts filter, count and aggregate so the model sees a short result, and cap cost with `maxRunsPerDay` and `maxSteps`. A `wakeIf` probe is optional: it pays only when a goal runs more than once an hour and most runs would find nothing, because it decides in zero tokens whether the model runs at all.
4. **Decide in the instructions, don't hope.** Write the decision rules ("if X, do Y, otherwise Z"), the inputs it will have and the output it must produce. Say what it must never do and why.
5. **Judgement goes to a human.** Unattended, a guess is worse than a pause. Where the right answer depends on preference or risk, instruct the agent to `ask_human` with the options. Anything with outside effects (sending, publishing, deploying, deleting) goes through `request_approval` with a draft file the human can read and edit.
6. **A defined end.** Every run finishes with one of: `done`, `nothing_to_do`, `blocked` (say what is missing), or `open` with a `next` step when it is waiting for something. Name the file it should leave as a deliverable.
7. **Small, explicit handoffs.** Hand off only to a teammate whose `description` says it handles this; put ids, paths and evidence in the handoff context, because the receiver sees nothing else. Expect a bounded number of hops (`harborMate.maxHops`) and never design two agents to hand work back and forth.
8. **Memory through the shared skill.** If it must build on earlier runs, use `loop-memory`; do not invent note files in the instructions.
9. **Prove it manually, then schedule it.** Create it with no schedule, give it a one-off task, read what it did, fix the instructions, and only then add a schedule with a conservative cadence and a daily cap.
10. **Facts live where they can be updated.** Put stable procedure in the instructions and changing facts (thresholds, owners, lists) in a skill reference file or in memory, so that updating them does not mean rewriting the role.

### Anti-patterns

| Anti-pattern | Why it hurts | Instead |
|---|---|---|
| **The do-everything agent** (many skills, many goals, a long prompt) | Instructions blur, mistakes are hard to trace, and one policy must cover every job | Split by role and by permission |
| **One agent per tiny task** | Overhead, handoff chatter, nobody owns the outcome | Make it a goal of the role that owns the area |
| **Vague mandate** ("monitor X and handle issues") | The model invents its own definition of "handle" | State the trigger, the decision rules, the output and the stopping point |
| **A frequent schedule with no probe** (more than once an hour, mostly nothing to do) | The model is called every interval to find nothing | Add a `wakeIf` probe, or lower the frequency. A daily or weekly schedule does not need one |
| **Using the model for arithmetic and filtering** | Slow, costly, and sometimes wrong | A skill script computes; the model interprets the result |
| **"Use your best judgement" unattended** | A confident guess on a risky call | Tell it when to `ask_human` |
| **Outside effects without approval**, or text embedded in the approval command | The human cannot review or edit what will happen | Draft in `.loop/outbox/`, approve a command that reads the draft |
| **Instructions that copy or contradict a skill** | Two sources of truth drift apart | Name the skill and say when to use it; keep the how in the skill |
| **Hard-coded business facts in the role** | The role goes stale silently | Move them to a skill reference or memory |
| **Handoff ping-pong** | Loops until the hop limit | One direction, with a clear contract; the receiver finishes |
| **Silent failure** (no data, then a confident answer) | Wrong output that looks right | Report a data gap and finish `blocked`; probes exit 2, not 1 |
| **A broad shared policy** for every agent | One prompt injection reaches everything | A policy per agent |
| **An open policy on an agent that reads outsiders' text** (customer messages, web pages, issue comments) | Injected instructions can run scripts | Keep it narrow; open policies are for agents that read only the owner's own files |
| **Scheduling before the first manual run works** | Failures pile up unattended | Manual first, then schedule with a cap |
| **Overlapping agents** with no owner of the overlap | Duplicate work, conflicting results | Give each responsibility exactly one agent |

## 8. Checklist before finishing

- [ ] Role file parses: run "Harbor Mate: Reload & Validate Team" and fix every reported problem.
- [ ] Every `loop.skills` entry exists, and the body names the skills for Chat mode.
- [ ] Scheduled roles have a `task`; a probe, if there is one, follows the exit-code contract and was run once by hand.
- [ ] The instructions say what to do, what never to do, when to ask the human, and how to finish.
- [ ] External effects go through approval with a draft in `.loop/outbox/`.
- [ ] Scripts are non-interactive, read secrets from the environment, and print small JSON.
- [ ] The policy grants only what the role needs.
- [ ] It ran once by hand on a real task before it was scheduled, and has a `maxRunsPerDay`.
