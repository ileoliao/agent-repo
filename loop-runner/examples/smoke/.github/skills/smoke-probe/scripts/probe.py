"""Smoke probe following the wakeIf contract: exit 0 = something to do (details on stdout), 1 = nothing."""
import json
import os
import sys

TRIGGER = "TRIGGER"

if not os.path.exists(TRIGGER):
    print("no trigger")
    sys.exit(1)

with open(TRIGGER, encoding="utf-8") as f:
    message = f.read().strip() or "(empty trigger file)"

# Consume the trigger so the next scheduled check does not fire again.
os.replace(TRIGGER, TRIGGER + ".consumed")
print(json.dumps({"trigger": True, "message": message}, ensure_ascii=False))
sys.exit(0)
