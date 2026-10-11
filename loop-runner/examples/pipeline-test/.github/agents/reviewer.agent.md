---
name: reviewer
description: Drafts release notes, asks for approval, publishes, then asks where to announce.
model: gpt-4o-mini
loop:
  skills: [review]
  task: Prepare and publish the release notes.
  maxSteps: 20
---
Follow your review skill exactly, one tool call per response, then finish.
