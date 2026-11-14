---
name: team-kb-publish
description: "Human-approved publisher for team-kb drafts. Use only inside request_approval commands after validating a draft under .loop/outbox/kb/, or interactively when opening a knowledge base pull request."
---

# Team Knowledge Base Publisher (`team-kb-publish`)

Do **not** add `team-kb-publish` to unattended agents' `loop.skills`. Unattended agents list `team-kb` and optionally `story-guard` and submit `publish.js` exclusively through `request_approval` so a human reviews the SHA-256-bound Markdown file in Harbor Mate Console first.

## Command

```sh
# Harbor Mate (after SHA-256 request_approval):
node .github/skills/team-kb-publish/scripts/publish.js .loop/outbox/kb/<domain>/<kind>/<slug>.md

# Standalone Copilot Chat / CLI (after reviewing staged draft):
node ~/.copilot/skills/team-kb-publish/scripts/publish.js ~/.harbor/drafts/kb/<domain>/<kind>/<slug>.md
```

When executed after approval, `publish.js`:
1. Re-validates the draft (schema, secrets, local user paths).
2. Creates a clean temporary `git worktree` on branch `kb/<domain>-<slug>-<timestamp>` without touching any dirty local checkout.
3. Writes `kb/<domain>/<kind>/<slug>.md`, commits, pushes the branch to `origin` when configured, and opens a GitHub pull request via `gh pr create` (or prints a one-click GitHub PR compare URL when `gh` is not configured).

The resolved target must be a separate private data repository. Configured pointers fail closed; public demo publishing is refused by default. Legacy cache drafts are read-compatible. `--no-push` preserves persistent drafts; published fingerprints are compared in the PR summary.
