# Writing skills with `@loop` (`propose_skill`)

A skill is what lets an unattended agent do something: query a system, aggregate data, call a local command. Its scripts are pre-approved for every agent that lists the skill, so the human reads every file before it is written. Your job is to propose a skill that is small, plain and easy to read.

## How to work

1. Ask what the skill is for and how it will be called, unless the human already said. A skill is worth a script only for work that is deterministic or repeated; otherwise a few lines of instructions are enough.
2. Read this guide, then `list_agents` / `get_agent` to see how existing skills are named and used. Never invent a command-line tool you did not see; if the script needs a local command (for example `harbor`), ask the human for its exact subcommands and flags.
3. Call `propose_skill` with `name`, `description`, `instructions` and the files. Every script and reference you create must be mentioned by name in `instructions`.
4. If the tool says "Not written", fix every listed error and call again. Warnings are shown to the human: reduce them where you can, and say in your reply which ones remain and why.
5. After the human applies it, wire it up with `propose_skills` (adds it to an agent's `loop.skills`). Say that the skill does nothing until an agent lists it.
6. `propose_skill` only creates. It never overwrites or edits an existing skill; to change one, tell the human what to change.

A policy file is still the human's to write. If the skill needs commands the agent will call itself (not from your script), say so and suggest the narrow `allowCommands` rule instead of widening anything.

<!-- shared reference: the same text is the body of .github/skills/loop-skill-authoring/SKILL.md (a test keeps them identical) -->

# Writing a skill for Loop Runner agents

A skill is a folder an agent can use: instructions in `SKILL.md`, and optionally scripts and reference files. Under Loop Runner agents run **unattended**, and the scripts of every skill an agent lists are **pre-approved**: the runtime runs them without checking what they do inside. So the code of a skill is the trust boundary. Keep scripts small, plain and readable, because a human reads them once, when the skill is created, and then they run on their own.

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
- **Credentials come from environment variables** (for example `HARBOR_PAT`). The human stores them with "Loop Runner: Set Secret". Never write a token into a script, never print one; the runtime redacts known secrets from output, but do not rely on that.
- **Print small, machine-readable output** (JSON preferred). Output beyond about 16 KB is cut to its head and tail. Whatever a script prints goes to the model, so mask or aggregate sensitive business data inside the script.
- **Meaningful exit codes.** 0 is success; non-zero is failure with the reason on stderr. A `wakeIf` probe follows its own contract: 0 means there is work, 1 means nothing to do, 2 or anything else means the probe is broken (use 2 when data could not be fetched, never 1).
- **Write only under `.loop/outbox/`.** A script must not touch `.github/` (agent and skill definitions) or other `.loop/` state (policies, queue, gates, tasks, memory). Those files define what the team may do, and only a human changes them. The automatic checks reject a script that mentions them.
- **Local commands** (for example `harbor`): call them from the script with an argument list, not a shell string built from data (`subprocess.run(["harbor", "status", name])`, not `os.system(f"harbor status {name}")`). The script, not the agent, is where the command is allowed, so list the subcommands the script needs in `SKILL.md`.
- **Network** is allowed inside a script (agents cannot call `curl` or `wget` themselves). Say in `SKILL.md` which hosts it contacts. Set timeouts on every request.
- **Scripts that send or publish something** (a message, a ticket, a deploy) must take the **draft file path** as an argument and read it, so the human can edit the draft before approving. Never embed the text in the command.
- **Idempotent where you can**: running it twice should not do the thing twice.
- Prefer the standard library. Do not install packages from inside a script.
- Plain file names in `scripts/` ending in `.py`, `.js`, `.mjs`, `.cjs`, `.sh` or `.ps1`; no sub-folders.

## 5. How an agent calls it

```
python3 .github/skills/<skill>/scripts/<script>.py --arg value
```

(`python`, `py`, `node`, `bash`, `sh`, `pwsh` and `powershell` also work.) Use forward slashes. Only scripts inside `scripts/` of a skill the agent lists are pre-approved, and a command containing `..` is never matched. The skill must be in the agent's `loop.skills` (or a goal's `skills`) to be usable.

## 6. Test before you trust it

Run each script by hand once with real arguments, in the workspace folder: check the output size, the exit codes (including a deliberate failure), that nothing prompts, and that it works with no secrets in your shell other than the ones it names. For a probe, check all of 0, 1 and 2. Then give it to one agent first.

## 7. Checklist

- [ ] The description says what and when; the name equals the folder.
- [ ] `SKILL.md` is under 500 lines, uses exact command lines, and mentions every file.
- [ ] Each script: no prompts, credentials from the environment, small output, exit codes that mean something.
- [ ] Nothing writes outside `.loop/outbox/`; nothing touches `.github/` or other `.loop/` state.
- [ ] Anything that sends or publishes takes a draft file path.
- [ ] You ran each script by hand, including a failure.
