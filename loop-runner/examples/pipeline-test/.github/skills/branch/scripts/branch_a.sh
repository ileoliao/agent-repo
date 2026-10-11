#!/usr/bin/env bash
# Branch A, one step: needs the code from the probe as its first argument.
read -r kind code < .loop/branch-check/expected
[ "$kind" = A ] || { echo "WRONG BRANCH: the probe chose $kind, not A" >&2; exit 1; }
[ "$1" = "$code" ] || { echo "WRONG CODE: got '$1'" >&2; exit 1; }
echo "A:$code" > .loop/outbox/branch/result.md
echo "branch A done, wrote result.md"
