---
name: brancher
description: Follows the branch skill: the probe's result decides what to run next.
model: gpt-4o-mini
loop:
  skills: [branch]
  task: Follow the branch skill.
  maxSteps: 12
---
Follow your branch skill exactly, then finish.
