#!/usr/bin/env bash
# After a run: did the later steps use what the probe printed? Prints PASS or FAIL.
cd "$(dirname "$0")"
read -r kind code < .loop/branch-check/expected || { echo "FAIL: no probe record"; exit 1; }
r=$(cat .loop/outbox/branch/result.md 2>/dev/null) || { echo "FAIL: no result.md (probe chose $kind $code)"; exit 1; }
if [ "$kind" = A ]; then want="A:$code"; else want="B:$code:$(printf '%s' "$code" | rev)"; fi
[ "$r" = "$want" ] && echo "PASS: branch $kind, result.md = $r" || echo "FAIL: result.md = $r, expected $want"
