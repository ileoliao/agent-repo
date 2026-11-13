---
title: "OTel Collector redline: memory_limiter must be the first processor in every pipeline"
summary: "Place memory_limiter before batch and tail_sampling in every OpenTelemetry Collector pipeline; otherwise traffic spikes buffer unboundedly and trigger OOMKilled data loss."
sources:
  - "harbor-sense:deploy/otelcol-config.yaml#memory_limiter"
triggers:
  - "memory_limiter"
  - "otelcol"
  - "OOMKilled"
  - "tail_sampling"
  - "processors"
---

## Guardrail

Whenever editing OpenTelemetry Collector configurations (`harbor-sense:deploy/otelcol-config.yaml`):
1. `memory_limiter` **must be the first item** in `processors` for every `traces`, `metrics`, and `logs` pipeline (strictly ahead of `batch`, `attributes`, and `tail_sampling`).
2. Keep `limit_percentage + spike_limit_percentage <= 85%` of container `resources.limits.memory`, and set `GOMEMLIMIT` to `80%` of the container memory limit.

## Why It Matters

If `batch` or `tail_sampling` precedes `memory_limiter`, spans accumulate inside downstream in-memory queues before backpressure engages, causing repeated pod `OOMKilled` crashes and silent telemetry loss.
