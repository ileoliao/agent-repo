---
title: "High-cardinality metric explosion (ErrSeriesLimitExceeded) quarantine runbook"
summary: "When Prometheus or Loki returns ErrSeriesLimitExceeded above 2M active series, quarantine unbounded labels with action: labeldrop instead of raising max_global_series_per_user."
sources:
  - "harbor-sense:deploy/relabel-rules.yaml#drop_unbounded_labels"
triggers:
  - "ErrSeriesLimitExceeded"
  - "high cardinality"
  - "labeldrop"
  - "drop_unbounded_labels"
  - "max_global_series"
---

## Trigger Signal

Ingesters return `HTTP 400: ErrSeriesLimitExceeded`, TSDB memory climbs sharply, and core SLI dashboards show gaps.

## Mitigation Steps

1. **Identify offending label**: Query `/api/v1/status/tsdb` (`seriesCountByLabelValuePair` and `labelValueCountByLabelName`) to locate labels carrying `request_id`, raw URL paths, or timestamps.
2. **Quarantine at ingest**: Add `action: labeldrop` in `harbor-sense:deploy/relabel-rules.yaml#drop_unbounded_labels` so aggregate metric series survive while stripping the unbounded label (use `action: drop` only for disposable debug metrics).
3. **Do NOT raise global caps blindly**: Never double `max_global_series_per_user` before isolating the leak, or query nodes will OOM and blind production alerting.
