"""Fake sender: prints the (possibly human-edited) draft and proves the secret is injected but redacted."""
import os
import sys

if len(sys.argv) < 2 or not os.path.exists(sys.argv[1]):
    print("usage: send.py <draft-file>", file=sys.stderr)
    sys.exit(2)

token = os.environ.get("SMOKE_TOKEN", "")
print(f"SENT (pretend). SMOKE_TOKEN present: {bool(token)}; value as seen in output: {token or '(not set)'}")
print("----- draft -----")
with open(sys.argv[1], encoding="utf-8") as f:
    print(f.read())
