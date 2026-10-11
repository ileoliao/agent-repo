---
name: pipeline
description: Runs a three-step pipeline from its skill.
model: gpt-4o-mini
loop:
  skills: [pipeline]
  task: Run the pipeline.
  maxSteps: 10
---
Run the three pipeline steps in order, then finish.
