#!/usr/bin/env bash
test -f .loop/outbox/pipeline/stage2.txt || { echo "step3: stage2 missing" >&2; exit 1; }
printf 'FINAL: ' > .loop/outbox/pipeline/final.md && cat .loop/outbox/pipeline/stage2.txt >> .loop/outbox/pipeline/final.md && cat .loop/outbox/pipeline/final.md
