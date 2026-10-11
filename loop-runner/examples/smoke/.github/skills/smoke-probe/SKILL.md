---
name: smoke-probe
description: Fake probe and fake sender for the Loop Runner smoke test. Touches only files inside this workspace.
---
- `scripts/probe.py --exit-code`: if a file named `TRIGGER` exists in the workspace root, prints its content, renames it to `TRIGGER.consumed`, and exits 0. Otherwise it exits 1.
- `scripts/send.py <draft>`: pretends to send the draft. It prints the draft and a masked token check, and writes nothing.
