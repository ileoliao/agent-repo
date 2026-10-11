---
name: review
description: Draft release notes, get them approved, publish, then ask where to announce.
---
Make exactly ONE tool call per response and wait for its result before the next call. Use the exact paths and values below.

1. Call run_command with `bash .github/skills/review/scripts/draft.sh`. It prints "draft written".
2. Call request_approval with: title "Publish release notes", summary "Review the draft, then approve to publish.", command `bash .github/skills/review/scripts/publish.sh`, files [".loop/outbox/review/draft.md"], wait true.
3. When the result starts with REJECTED, read the feedback. Call write_file to overwrite `.loop/outbox/review/draft.md` with release notes that follow the feedback (one short line is fine). Then call request_approval again with exactly the same arguments as step 2.
4. When the result starts with APPROVED, call ask_human with: question "Which channel should I announce in?", context "The release notes were published.", options ["#releases", "#ops"].
5. When the result starts with "The human answered", call write_file with path `.loop/outbox/review/announce.md` and content `Announce in <the channel they chose>`.
6. Then call finish with status done and the summary `Published and announced in <the channel>`.
