#!/usr/bin/env bash
# Zero-token wake check: exit 0 (and print the text) only when .loop/trigger.txt exists; otherwise exit 1.
f=.loop/trigger.txt
[ -s "$f" ] || exit 1
cat "$f"; mv "$f" .loop/trigger.consumed.txt
