---
name: branch
description: Run the probe, then follow the branch the probe chose. Later steps need values printed by earlier steps.
---
All commands are run with run_command. IMPORTANT: make exactly ONE tool call per response, then wait for its result before deciding the next call. Never put two calls in one response: a later command needs a value that an earlier command prints, and you cannot know that value before you see the result. Use the exact paths. Never read files under .loop/ to find the values; use only what the commands print.

1. Run `bash .github/skills/branch/scripts/probe.sh`. It prints `PROBE RESULT: branch=<A or B> code=<CODE>`.
2. If the branch is A: run `bash .github/skills/branch/scripts/branch_a.sh <CODE>` with the code from step 1, then call finish with status done and the summary `A <CODE>`.
3. If the branch is B:
   a. Run `bash .github/skills/branch/scripts/branch_b1.sh <CODE>` with the code from step 1. It prints `TICKET=<TICKET>`.
   b. Only after you have seen the output of 3a, in a NEW response: run `bash .github/skills/branch/scripts/branch_b2.sh <TICKET>` with the actual ticket text printed in 3a (never the literal word TICKET), then call finish with status done and the summary `B <CODE> <TICKET>`.
4. If any command prints WRONG, do not guess: call finish with status blocked and say what it printed.
