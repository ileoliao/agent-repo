#!/usr/bin/env bash
# Branch B, step 1 of 2: needs the code from the probe as its first argument; prints a ticket for step 2.
read -r kind code < .loop/branch-check/expected
[ "$kind" = B ] || { echo "WRONG BRANCH: the probe chose $kind, not B" >&2; exit 1; }
[ "$1" = "$code" ] || { echo "WRONG CODE: got '$1'" >&2; exit 1; }
ticket=$(printf '%s' "$code" | rev)
echo "$ticket" > .loop/branch-check/ticket
echo "B step 1 ok. TICKET=$ticket"
