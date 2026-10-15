#!/usr/bin/env bash
# Creates log-based metrics and Cloud Monitoring alert policies for heartbeat-probe.
#
# Usage:
#   PROJECT_ID=my-proj CHANNEL_ID=1234567890 ./setup.sh
# Optional:
#   LOG_SCOPE   extra Cloud Logging filter that selects the probe's logs
#               (default: GKE container named heartbeat-probe)
#   PROBE_NAME  default e2e
#   ABSENT_FOR  seconds without a matched heartbeat before paging (default 900 = 3 cycles of 300s)
#   LATENCY_MAX seconds, p95 end-to-end latency threshold (default 180)
#
# CHANNEL_ID must be a notification channel that does NOT depend on the
# Grafana/Mimir stack being monitored (e.g. email/SMS/PagerDuty directly).
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${CHANNEL_ID:?set CHANNEL_ID}"
PROBE_NAME="${PROBE_NAME:-e2e}"
LOG_SCOPE="${LOG_SCOPE:-resource.type=\"k8s_container\" AND resource.labels.container_name=\"heartbeat-probe\"}"
ABSENT_FOR="${ABSENT_FOR:-900}"
LATENCY_MAX="${LATENCY_MAX:-180}"
CHANNEL="projects/${PROJECT_ID}/notificationChannels/${CHANNEL_ID}"
BASE="${LOG_SCOPE} AND jsonPayload.probe=\"${PROBE_NAME}\""

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

counter() {  # name, extra filter, description
  cat >"$work/$1.yaml" <<EOF
description: "$3"
filter: '${BASE} AND $2'
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
EOF
  upsert_metric "$1"
}

upsert_metric() {
  if gcloud logging metrics describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud logging metrics update "$1" --project "$PROJECT_ID" --config-from-file "$work/$1.yaml"
  else
    gcloud logging metrics create "$1" --project "$PROJECT_ID" --config-from-file "$work/$1.yaml"
  fi
}

# ---- log-based metrics ------------------------------------------------------
counter heartbeat_probe_sent \
  'jsonPayload.event="probe_sent"' \
  "Probe entered firing phase"
counter heartbeat_probe_matched \
  'jsonPayload.event="alert_received" AND jsonPayload.status="firing" AND jsonPayload.matched=true' \
  "Grafana firing notification matched to a sent probe"
counter heartbeat_probe_timeout \
  'jsonPayload.event="probe_timeout"' \
  "Probe sent but no matching firing notification arrived in time"

cat >"$work/heartbeat_probe_latency.yaml" <<EOF
description: "End-to-end latency from probe_sent to matched firing notification"
filter: '${BASE} AND jsonPayload.event="alert_received" AND jsonPayload.status="firing" AND jsonPayload.matched=true'
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: s
valueExtractor: EXTRACT(jsonPayload.latency_seconds)
bucketOptions:
  explicitBuckets:
    bounds: [15, 30, 45, 60, 90, 120, 180, 240, 300]
EOF
upsert_metric heartbeat_probe_latency

# ---- alert policies ---------------------------------------------------------
m() { echo "metric.type=\\\"logging.googleapis.com/user/$1\\\""; }

policy() {  # file name; body is read from stdin
  cat >"$work/$1.json"
  gcloud alpha monitoring policies create --project "$PROJECT_ID" --policy-from-file "$work/$1.json"
}

policy chain-broken <<EOF
{
  "displayName": "[Heartbeat/${PROBE_NAME}] Alerting pipeline broken",
  "combiner": "OR",
  "conditions": [{
    "displayName": "No matched heartbeat for ${ABSENT_FOR}s",
    "conditionAbsent": {
      "filter": "$(m heartbeat_probe_matched)",
      "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM"}],
      "duration": "${ABSENT_FOR}s",
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["${CHANNEL}"],
  "alertStrategy": {"autoClose": "1800s"},
  "documentation": {"mimeType": "text/markdown", "content": "Metrics -> Mimir -> Grafana rule -> webhook loop has not completed. Check heartbeat-probe logs: probe_sent present but no alert_received => stack broken; no probe_sent => probe itself is down (see the probe-down policy)."}
}
EOF

policy repeated-timeouts <<EOF
{
  "displayName": "[Heartbeat/${PROBE_NAME}] Repeated probe timeouts",
  "combiner": "OR",
  "conditions": [{
    "displayName": "2+ probe timeouts in 30m",
    "conditionThreshold": {
      "filter": "$(m heartbeat_probe_timeout)",
      "aggregations": [{"alignmentPeriod": "1800s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM"}],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 1,
      "duration": "0s",
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["${CHANNEL}"],
  "alertStrategy": {"autoClose": "3600s"},
  "documentation": {"mimeType": "text/markdown", "content": "Heartbeats are intermittently lost (partial failure, rule errors, webhook delivery failures)."}
}
EOF

policy slow <<EOF
{
  "displayName": "[Heartbeat/${PROBE_NAME}] Alerting pipeline slow",
  "combiner": "OR",
  "conditions": [{
    "displayName": "p95 end-to-end latency > ${LATENCY_MAX}s",
    "conditionThreshold": {
      "filter": "$(m heartbeat_probe_latency)",
      "aggregations": [{"alignmentPeriod": "1800s", "perSeriesAligner": "ALIGN_PERCENTILE_95", "crossSeriesReducer": "REDUCE_MAX"}],
      "comparison": "COMPARISON_GT",
      "thresholdValue": ${LATENCY_MAX},
      "duration": "0s",
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["${CHANNEL}"],
  "alertStrategy": {"autoClose": "3600s"}
}
EOF

policy probe-down <<EOF
{
  "displayName": "[Heartbeat/${PROBE_NAME}] Probe service not sending",
  "combiner": "OR",
  "conditions": [{
    "displayName": "No probe_sent for ${ABSENT_FOR}s",
    "conditionAbsent": {
      "filter": "$(m heartbeat_probe_sent)",
      "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM"}],
      "duration": "${ABSENT_FOR}s",
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["${CHANNEL}"],
  "alertStrategy": {"autoClose": "1800s"}
}
EOF

echo "Done. Re-running creates duplicate policies; delete old ones first if you change them."
