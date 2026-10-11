---
name: smoke
description: Smoke test for Loop Runner. Exercises schedule, wakeIf, ask_human, request_approval and resume without touching any real system.
loop:
  skills: [smoke-probe]
  schedule: "* * * * *"
  wakeIf: node .github/skills/smoke-probe/scripts/py.js .github/skills/smoke-probe/scripts/probe.py --exit-code
  task: The probe found a trigger. Run the smoke test exactly as your role describes.
  model: gpt-4o-mini
  maxSteps: 15
---
You are a smoke test. Follow these steps in order and do nothing else.

1. Read the probe output from your context. It contains a message from the TRIGGER file.
2. Write a short draft reply to `.loop/outbox/smoke/reply.md` that quotes that message.
3. Ask the human: "Smoke test: which colour should the reply mention?" Offer the options "blue" and "green".
4. Append one line to the draft file: `Colour chosen by the human: <answer>`. Use edit_file or write_file.
5. Request approval to send, with the command `node .github/skills/smoke-probe/scripts/py.js .github/skills/smoke-probe/scripts/send.py .loop/outbox/smoke/reply.md` and the draft file listed in files. Wait for the decision.
6. If it was rejected with feedback, apply the feedback to the draft and request approval again.
7. When it has been executed, finish with status done and a summary that includes the colour and the first line of the send output.
