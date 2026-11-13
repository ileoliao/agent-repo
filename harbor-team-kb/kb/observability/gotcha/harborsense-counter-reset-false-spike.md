---
title: "Rolling restarts of harbor-ingester cause false-positive error_rate spikes from counter resets"
summary: "Raw subtraction or naive SQL deltas on monotonic counter harborsense_ingest_total misread pod restart counter resets as 10x error_rate spikes; always use reset-aware rate()/increase()."
sources:
  - "harbor-sense:internal/metrics/prom_queries.go#BuildErrorRateQuery"
triggers:
  - "harborsense_ingest_total"
  - "BuildErrorRateQuery"
  - "error_rate"
  - "counter reset"
  - "false positive"
---

## Symptom

Within 5 minutes of a routine `harbor-ingester` rolling deployment or pod restart, custom anomaly queries report sudden `error_rate` jumps or negative throughput cliffs while gateway error logs remain flat.

## Root Cause

PromQL `rate()` and `increase()` handle monotonic counter resets when a pod restarts from zero, whereas raw offset subtraction (`metric - metric offset 5m`) or SQL/ClickHouse aggregations without per-`(pod, instance)` reset handling miscalculate the reset boundary as a massive spike.

## Verification Checklist

1. Correlate transient `error_rate` spikes against `kube_pod_container_status_restarts_total` and recent rollouts.
2. Ensure alert and investigation queries use `harbor-sense:internal/metrics/prom_queries.go#BuildErrorRateQuery` (`sum(rate(...[5m])) / clamp_min(sum(rate(...[5m])), 1)`).
