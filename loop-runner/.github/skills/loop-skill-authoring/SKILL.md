---
name: loop-skill-authoring
description: Write, review or change a skill (SKILL.md plus scripts) that agents use unattended under Harbor Mate, including a wakeIf probe, a wrapper around a local command, or a script that cuts token use by filtering and aggregating data. Use whenever the user asks for a new skill or a helper script for an agent, says an agent should not read all that data itself, or asks you to check a skill's scripts, even if they do not say "skill".
---

# Writing a skill for Harbor Mate agents

A skill is a folder an agent can use: instructions in `SKILL.md`, and optionally scripts and reference files. Under Harbor Mate agents run **unattended**, and the scripts of every skill an agent lists are **pre-approved**: the runtime runs them without checking what they do inside. So the code of a skill is the trust boundary. Keep scripts small, plain and readable, because a human reads them once, when the skill is created, and then they run on their own.

## 1. Does this need a script?

- **Instructions only** when the skill is a procedure, a checklist, a house style, or how to use tools the agent already has. Most skills are this.
- **A script** when the work is deterministic or repeated: querying an API, aggregating a large file, calling a local command. The point of a script is to keep data out of the model: let it filter, aggregate and compute, and print a small result. Reading 10,000 log lines costs tokens every run; a script that prints the 20 interesting ones costs almost none, and gives the same answer every time.
- If the same helper would be written again and again by agents, put it in `scripts/` once.

## 2. Anatomy

```
.github/skills/<skill-name>/
├── SKILL.md        required: frontmatter (name, description) + instructions
├── scripts/        executables the agent runs
└── references/     longer docs the agent reads only when needed
```

- **name**: lowercase letters, digits and hyphens, at most 63 characters, equal to the folder name.
- **description**: say what the skill does **and when to use it**. It is all an agent sees before deciding to read the rest, so it is what makes the skill get picked. Name the situations and the words a task would use, a little generously, because agents tend to under-use skills. Keep it under 1024 characters.
  - Weak: `Helps with release data.`
  - Strong: `Summarises the last 24 hours of Harbor release health into a short table. Use when a task mentions release health, a failed rollout or a deploy check, even if it does not say "summary".`
- **Body under 500 lines.** Put detail in `references/` and say in `SKILL.md` when to read each file. For a reference file over 300 lines, start it with a table of contents. Unattended agents work best when the body is short enough to read in full every time.

## 3. Writing SKILL.md

- Use the imperative ("Run `report.py` with the date"), and give the exact command line, with a real example.
- Explain **why** a rule exists. An agent that understands the reason handles the case you did not think of; a bare "NEVER" gets followed rigidly or ignored.
- Say what the output looks like, what each exit code means, and what to do when the script fails (usually: report a data gap and stop; never fill gaps from memory).
- Mention every file in the skill by name and say when to use it. Anything not mentioned is invisible.
- Keep it general. Write for the whole class of tasks, not for the one example in front of you.
- A skill must not surprise the person who reads its description: it does what it says, nothing else.

## 4. Script rules (required by the runtime)

Commands run with stdin closed and a hard timeout (default 180 s), so:

- **Non-interactive.** Never prompt, open a pager or wait for input. Take values from arguments or environment variables.
- **Credentials come from environment variables** (for example `HARBOR_PAT`). The human stores them with "Harbor Mate: Set Secret". Never write a token into a script, never print one; the runtime redacts known secrets from output, but do not rely on that.
- **Print small, machine-readable output** (JSON preferred). Output beyond about 16 KB is cut to its head and tail. Whatever a script prints goes to the model, so mask or aggregate sensitive business data inside the script.
- **Meaningful exit codes.** 0 is success; non-zero is failure with the reason on stderr. A `wakeIf` probe follows its own contract: 0 means there is work, 1 means nothing to do, 2 or anything else means the probe is broken (use 2 when data could not be fetched, never 1).
- **Write only under `.loop/outbox/`.** A script must not touch `.github/` (agent and skill definitions) or other `.loop/` state (policies, queue, gates, tasks, memory). Those files define what the team may do, and only a human changes them. The automatic checks reject a script that mentions them.
- **Local commands** (for example `harbor`): call them from the script with an argument list, not a shell string built from data (`subprocess.run(["harbor", "status", name])`, not `os.system(f"harbor status {name}")`). The script, not the agent, is where the command is allowed, so list the subcommands the script needs in `SKILL.md`.
- **Network** is allowed inside a script (agents cannot call `curl` or `wget` themselves). Say in `SKILL.md` which hosts it contacts. Set timeouts on every request.
- **Scripts that send or publish something** (a message, a ticket, a deploy) must take the **draft file path** as an argument and read it, so the human can edit the draft before approving. Never embed the text in the command.
- **Idempotent where you can**: running it twice should not do the thing twice.
- Prefer the standard library. Do not install packages from inside a script.
- Plain file names in `scripts/` ending in `.py`, `.js`, `.mjs`, `.cjs`, `.sh` or `.ps1`; no sub-folders.

### A `wakeIf` probe in practice

A probe answers "is there anything to do?" without a model call. It prints what it found (briefly) and exits 0, exits 1 when there is nothing, and exits 2 when it could not check. A skeleton (replace the command with the real one):

```python
#!/usr/bin/env python3
"""Exit 0: something to handle (print what). 1: nothing to do. 2: could not check."""
import json, subprocess, sys

try:
    out = subprocess.run(["<your-cli>", "list", "--status", "failed"], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        print(out.stderr.strip()[:500], file=sys.stderr)
        sys.exit(2)
    items = json.loads(out.stdout)
except Exception as e:
    print(f"could not check: {e}", file=sys.stderr)
    sys.exit(2)

if not items:
    sys.exit(1)
print(json.dumps({"count": len(items), "items": items[:20]}))
sys.exit(0)
```

The agent must list the skill the probe lives in, and `wakeIf: python3 .github/skills/<skill>/scripts/check.py` is the command.

## 5. How an agent calls it

```
python3 .github/skills/<skill>/scripts/<script>.py --arg value
```

(`python`, `py`, `node`, `bash`, `sh`, `pwsh` and `powershell` also work.) Use forward slashes. Only scripts inside `scripts/` of a skill the agent lists are pre-approved, and a command containing `..` is never matched. The skill must be in the agent's `loop.skills` (or a goal's `skills`) to be usable.

## 6. Test before you trust it

Run each script by hand once with real arguments, in the workspace folder: check the output size, the exit codes (including a deliberate failure), that nothing prompts, and that it works with no secrets in your shell other than the ones it names. For a probe, check all of 0, 1 and 2. Then give it to one agent first.

## 7. Changing an existing skill

Agents rely on a skill's behaviour, and the change reaches their next unattended run with nobody watching. So:

- **Make the smallest change that does the job.** Edit the lines that need it; do not rewrite a working script.
- **Keep the contract.** The command line, the shape of the output and the exit codes are what agents and `wakeIf` probes depend on. If one must change, change `SKILL.md` and every place that calls it in the same step, and say so.
- **Keep the description true.** If what the skill does or when to use it changes, update `description`, because it is how agents choose the skill.
- **Know who uses it.** Check which agents list the skill before changing it, and tell the human.
- **A changed script is re-judged.** The rules in section 4 apply to the new version, and a human reads the diff.
- **Test again by hand** (section 6), including the failure path.

## 8. Checklist

- [ ] The description says what and when; the name equals the folder.
- [ ] `SKILL.md` is under 500 lines, uses exact command lines, and mentions every file.
- [ ] Each script: no prompts, credentials from the environment, small output, exit codes that mean something.
- [ ] Nothing writes outside `.loop/outbox/`; nothing touches `.github/` or other `.loop/` state.
- [ ] Anything that sends or publishes takes a draft file path.
- [ ] You ran each script by hand, including a failure.
- [ ] For a change: the contract (arguments, output, exit codes) still holds, or every caller was updated.
