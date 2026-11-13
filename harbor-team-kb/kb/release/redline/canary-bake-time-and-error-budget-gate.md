---
title: "Tier-0 release redline: 5% canary requires 20-minute bake time and 1.5x error_rate abort gate"
summary: "Production rollouts of harbor-gateway, harbor-sense, and harbor-store must hold 5% canary traffic for at least 20 minutes and auto-abort if error_rate exceeds 1.5x baseline or P99 doubles."
sources:
  - "harbor-deploy:rollouts/tier0-canary.yaml#CanaryAnalysisTemplate"
triggers:
  - "CanaryAnalysisTemplate"
  - "tier0-canary"
  - "canary"
  - "bake time"
  - "error_rate"
---

## Guardrail

Never bypass canary analysis for Tier-0 services (`harbor-gateway`, `harbor-sense`, `harbor-store`):
1. Hold initial canary weight at **<= 5%** for a minimum **20-minute bake time** to cover async consumer lag and connection pool warm-up.
2. Configure `harbor-deploy:rollouts/tier0-canary.yaml#CanaryAnalysisTemplate` to automatically roll back canary weight to `0%` if `error_rate > 1.5 * baseline` or `p99_latency > 2.0 * baseline` across two consecutive intervals.

## Emergency Exception

Skipping canary bake time is permitted only during an active P0 total outage when the current version is unrecoverable and two on-call leads sign off in the incident channel.
