---
name: jira-board
description: Read the team's Jira board and get a small, pre-computed digest of progress, risks and what changed since yesterday. Use for the daily team brief.
---
# Jira board digest

Run one command. It does all the counting and the comparison with yesterday's snapshot; you only write the story.

```
python3 .github/skills/jira-board/scripts/digest.py
```

It prints JSON:

- `sprint`: name, goal, `daysLeft`, `percentElapsed`, `percentDoneByCount`, `behindSchedule` (scrum boards only; null on kanban).
- `totals`: `todo`, `doing`, `done`, `all`, `unassignedOpen`, `doneLast24h`. `storyPoints` is null unless configured.
- `byAssignee`: open and done counts per person (largest open load first).
- `risks`: `blocked`, `overdue`, `dueSoon`, `stale` (in progress with no update for several days), each a short list with `key`, `summary`, `status`, `assignee`, `url`. `riskCounts` has the real totals when a list was cut.
- `doneLast24h`: what was finished since yesterday.
- `delta`: against the previous snapshot: `newlyDone`, `newlyBlocked`, `added`, `removed` (keys). Null on the first run.

Exit codes: 0 ok. 2 means configuration or credentials are wrong (`JIRA_TOKEN`, `JIRA_EMAIL` for Jira Cloud, `boardId`, `baseUrl` in `config.json`). 3 means Jira is unreachable or erroring. On 2 or 3, do not guess numbers: finish with status `blocked` and put the stderr message in the summary.

Rules: use only what the digest says. Do not invent issues, owners or dates. Describe the state of the work, not the worth of the people.
