---
name: team-kb-publish
description: "Human-approved publisher for team-kb drafts. Use only inside request_approval commands after validating a draft under .loop/outbox/kb/, or interactively when opening a knowledge base pull request."
---

# Team Knowledge Base Publisher (`team-kb-publish`)

Do **not** add `team-kb-publish` to unattended agents' `loop.skills`. Unattended agents list only `team-kb` and submit `publish.py` exclusively through `request_approval` so a human reviews the SHA-256-bound Markdown file in Harbor Mate Console first.

## Command

```sh
python3 .github/skills/team-kb-publish/scripts/publish.py .loop/outbox/kb/<domain>/<kind>/<slug>.md
```

When executed after approval, `publish.py`:
1. Re-validates `.loop/outbox/kb/<domain>/<kind>/<slug>.md` (schema, secrets, local user paths).
2. Creates a clean temporary `git worktree` on branch `kb/<domain>-<slug>-<timestamp>` without touching any dirty local checkout.
3. Writes `kb/<domain>/<kind>/<slug>.md`, commits, pushes the branch to `origin` when configured, and opens a GitHub pull request via `gh pr create` when connected to GitHub.
