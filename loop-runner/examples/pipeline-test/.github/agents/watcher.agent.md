---
name: watcher
description: Wakes on a schedule, but only calls the model when .loop/trigger.txt exists.
model: gpt-4o-mini
loop:
  skills: [watch]
  schedule: "* * * * *"
  wakeIf: bash .github/skills/watch/scripts/check.sh
  task: A trigger arrived. Write the report as your watch skill says.
  maxSteps: 8
  maxRunsPerDay: 50
---
Follow your watch skill exactly, one tool call per response, then finish.
