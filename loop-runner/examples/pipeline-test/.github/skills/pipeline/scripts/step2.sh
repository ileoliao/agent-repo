#!/usr/bin/env bash
test -f .loop/outbox/pipeline/stage1.txt || { echo "step2: stage1 missing" >&2; exit 1; }
tr a-z A-Z < .loop/outbox/pipeline/stage1.txt > .loop/outbox/pipeline/stage2.txt && echo "step2 wrote stage2"
