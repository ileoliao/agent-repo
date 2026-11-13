---
title: "RateLimitConfig changes require 24h shadow_only observation before enforcing 429"
summary: "Never deploy harbor-gateway RateLimitConfig quota or burst changes directly in enforcing mode; run shadow_only: true for at least 24 hours first."
sources:
  - "harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig"
triggers:
  - "RateLimitConfig"
  - "shadow_only"
  - "429 Too Many Requests"
  - "rate limit"
  - "限流"
---

## Guardrail

Never ship quota, QPS, or token-bucket `burst` changes in `harbor-gateway` directly with `shadow_only: false` in production.

Follow a mandatory two-stage rollout:
1. Deploy with `shadow_only: true` so the limiter only increments `gateway_ratelimit_would_reject_total` and logs sampled tenant hits without returning HTTP `429`.
2. Observe for at least **24 hours** (covering peak traffic and scheduled partner batch windows) before flipping `shadow_only: false`.

## Background

Multi-tenant gateway traffic includes periodic partner batch bursts and reconnect waves. Sizing `burst` from daily average QPS previously throttled legitimate batch workers within 3 minutes of rollout and triggered a synchronized retry storm (`harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig`).
