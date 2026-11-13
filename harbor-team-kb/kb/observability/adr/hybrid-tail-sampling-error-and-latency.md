---
title: "ADR: 100% error and slow-trace tail sampling (>2500ms) with 5% baseline sampling"
summary: "harbor-sense retains 100% of error traces and traces slower than 2500ms via tail_sampling while sampling healthy fast traces at 5% to cut trace storage cost by 72%."
sources:
  - "harbor-sense:deploy/otelcol-config.yaml#tail_sampling"
triggers:
  - "tail_sampling"
  - "2500ms"
  - "trace missing"
  - "sampling rate"
---

## Decision

Storing 100% of distributed traces consumed 72% of observability storage even though over 95% of spans were healthy fast `200 OK` requests, whereas uniform 5% head sampling dropped rare failure traces.

Configured in `harbor-sense:deploy/otelcol-config.yaml#tail_sampling`:
1. **100% Error Retention**: Keep every trace with `status_code == ERROR` or HTTP `status >= 500`.
2. **100% Slow-Trace Retention**: Keep every trace with end-to-end duration `>= 2500ms`.
3. **5% Healthy Baseline**: Deterministically hash-sample remaining healthy traces at **5%** for baseline latency comparison.

## Operational Implication

Never compute total request QPS by counting raw trace spans; always query Prometheus metrics because healthy fast traces are down-sampled 20x.
