#!/usr/bin/env bash
# Picks a random branch (A or B) and a random code. The answer is ONLY printed, never written where the
# next steps can read it for the model; the checker compares the later steps' arguments with this record.
set -e
mkdir -p .loop/outbox/branch .loop/branch-check
code=$(printf '%04x' $((RANDOM * 2 % 65536)) | tr a-f A-F)
if [ $((RANDOM % 2)) -eq 0 ]; then kind=A; else kind=B; fi
rm -f .loop/outbox/branch/*
echo "$kind $code" > .loop/branch-check/expected
echo "PROBE RESULT: branch=$kind code=$code"
