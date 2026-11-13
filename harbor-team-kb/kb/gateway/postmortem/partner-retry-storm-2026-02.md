---
title: "2026-02 Postmortem: Fixed Retry-After header caused 3.4x partner webhook 429 retry storm"
summary: "Returning a constant Retry-After: 5 header synchronized thousands of throttled webhook workers into 5-second sawtooth retry waves (request_rate 3.4x); fixed with jittered backoff."
sources:
  - "harbor-gateway:pkg/middleware/retry_after.go#WriteRetryHeader"
triggers:
  - "request_rate"
  - "Retry-After"
  - "WriteRetryHeader"
  - "429"
  - "retry storm"
  - "webhook"
---

## Incident Summary

`sentinel` paged on `harbor-gateway` `request_rate` jumping to **3.4x** baseline with HTTP `429` responses reaching 38% and traffic forming a sharp 5-second sawtooth wave.

## Root Cause

1. A partner batch job briefly exceeded its tenant token-bucket `burst` and received HTTP `429`.
2. `WriteRetryHeader` returned a hardcoded `Retry-After: 5` without jitter, causing thousands of concurrent workers to retry at the exact same second, immediately exhausting the bucket again and amplifying incoming load.

## Fix & Investigation Checklist

- `harbor-gateway:pkg/middleware/retry_after.go#WriteRetryHeader` now applies uniform random jitter `[base, base * 1.8]` and exponential backoff up to `60s` for repeated per-`client_id` throttling.
- When `request_rate` exhibits fixed-interval sawtooth spikes alongside `429`, inspect `Retry-After` response headers and top `client_id` concentration first.
