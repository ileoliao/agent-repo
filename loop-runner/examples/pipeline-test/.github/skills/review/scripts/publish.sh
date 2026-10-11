#!/usr/bin/env bash
cp .loop/outbox/review/draft.md .loop/outbox/review/published.md && echo "published: $(cat .loop/outbox/review/published.md)"
