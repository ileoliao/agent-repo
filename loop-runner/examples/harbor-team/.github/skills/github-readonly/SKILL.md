---
name: github-readonly
description: Read code, docs and recent commits from the allowed GitHub repositories. Read-only; cannot reach any other repository.
---
# GitHub code and docs (read-only)

```
python3 .github/skills/github-readonly/scripts/gh_read.py repos
python3 .github/skills/github-readonly/scripts/gh_read.py search  --repo ORG/NAME --q "text to find"
python3 .github/skills/github-readonly/scripts/gh_read.py file    --repo ORG/NAME --path src/a.go --ref main --start 1 --end 120
python3 .github/skills/github-readonly/scripts/gh_read.py tree    --repo ORG/NAME --path docs
python3 .github/skills/github-readonly/scripts/gh_read.py commits --repo ORG/NAME --since 2026-10-10T00:00:00Z --limit 10
```

Run `repos` first: it lists the repositories you may read (`allowedRepos`) and which of them hold documentation (`docsRepos`). Any other repository is refused.

- `search` finds code or docs by text (GitHub code search; it can lag behind the newest commits and ignores very large files).
- `file` prints numbered lines with a link to the exact range. Cite code as `repo:path:line` and keep the link. Long files are cut; ask for the next range with `--start`.
- `tree` lists a directory. `commits` lists recent changes, optionally for one path: use it to see what changed shortly before an incident started.

Exit codes: 0 ok, 2 bad arguments, a repository that is not allowed, or a missing `GITHUB_TOKEN`, 3 GitHub unreachable or erroring (a 404 can also mean the token cannot see the repository). Report failures; never fill the gap with what you remember of the code.
