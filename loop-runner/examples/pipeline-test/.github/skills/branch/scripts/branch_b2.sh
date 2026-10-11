#!/usr/bin/env bash
# Branch B, step 2 of 2: needs the TICKET printed by step 1 as its first argument.
[ -f .loop/branch-check/ticket ] || { echo "run branch_b1.sh first" >&2; exit 1; }
[ "$1" = "$(cat .loop/branch-check/ticket)" ] || { echo "WRONG TICKET: got '$1'" >&2; exit 1; }
read -r kind code < .loop/branch-check/expected
echo "B:$code:$1" > .loop/outbox/branch/result.md
echo "branch B done, wrote result.md"
