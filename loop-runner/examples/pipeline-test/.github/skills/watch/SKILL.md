---
name: watch
description: Report what a trigger said.
---
You were woken because a trigger arrived; its text is in the work item context.
Make exactly ONE tool call per response.
1. Call write_file with path `.loop/outbox/watch/report.md` and content `Trigger: <the trigger text from the context>`.
2. Call finish with status done and the summary `Reported: <the trigger text>`.
