#!/usr/bin/env bash
# Creates log-based metrics and Cloud Monitoring alert policies for heartbeat-probe.
# All metrics carry a `replica` label; absence alerts fire per replica.
#
# Usage:
#   PROJECT_ID=my-proj CHANNEL_ID=1234567890 ./setup.sh
# Optional:
#   LOG_SCOPE   Cloud Logging filter that selects the probe's logs
#               (default: GKE container named heartbeat-probe)
#   PROBE_NAME  default e2e
#   ABSENT_FOR  seconds without a matched heartbeat before paging (default 900 = 3 cycles of 300s)
#   LATENCY_MAX seconds, p95 end-to-end latency threshold (default 180)
#
# CHANNEL_ID must be a notification channel that does NOT depend on the
# Grafana/Mimir stack being monitored (e.g. email/SMS/PagerDuty directly).
#
# Note: absence is tracked per replica name. Use a StatefulSet (stable names)
# and expect one alert per removed replica when you scale DOWN.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${CHANNEL_ID:?set CHANNEL_ID}"
PROBE_NAME="${PROBE_NAME:-e2e}"
LOG_SCOPE="${LOG_SCOPE:-resource.type=\"k8s_container\" AND resource.labels.container_name=\"heartbeat-probe\"}"
ABSENT_FOR="${ABSENT_FOR:-900}"
LATENCY_MAX="${LATENCY_MAX:-180}"
CHANNEL="projects/${PROJECT_ID}/notificationChannels/${CHANNEL_ID}"
BASE="${LOG_SCOPE} AND jsonPayload.probe=\"${PROBE_NAME}\""
MATCHED='jsonPayload.event="alert_received" AND jsonPayload.status="firing" AND jsonPayload.matched=true'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

upsert_metric() {
  if gcloud logging metrics describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud logging metrics update "$1" --project "$PROJECT_ID" --config-from-file "$work/$1.yaml"
  else
    gcloud logging metrics create "$1" --project "$PROJECT_ID" --config-from-file "$work/$1.yaml"
  fi
}

counter() {  # name, extra filter, description
  cat >"$work/$1.yaml" <<EOF
description: "$3"
filter: '${BASE} AND $2'
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: replica
      valueType: STRING
labelExtractors:
  replica: EXTRACT(jsonPayload.replica)
EOF
  upsert_metric "$1"
}

# ---- log-based metrics ------------------------------------------------------
counter heartbeat_probe_sent 'jsonPayload.event="probe_sent"' \
  "Probe entered firing phase (replica = sender)"
counter heartbeat_probe_matched "${MATCHED}" \
  "Grafana firing notification validated for a probe (replica = original sender)"

cat >"$work/heartbeat_probe_latency.yaml" <<EOF
description: "End-to-end latency from probe start to validated firing notification"
filter: '${BASE} AND ${MATCHED}'
metricDescriptor:
  metricKind: DELTA
  valueType: DISTRIBUTION
  unit: s
  labels:
    - key: replica
      valueType: STRING
labelExtractors:
  replica: EXTRACT(jsonPayload.replica)
valueExtractor: EXTRACT(jsonPayload.latency_seconds)
bucketOptions:
  explicitBuckets:
    bounds: [15, 30, 45, 60, 90, 120, 180, 240, 300]
EOF
upsert_metric heartbeat_probe_latency

# ---- alert policies ---------------------------------------------------------
m() { echo "metric.type=\\\"logging.googleapis.com/user/$1\\\""; }
PER_REPLICA='"crossSeriesReducer": "REDUCE_SUM", "groupByFields": ["metric.label.replica"]'

policy() {  # file name; body is read from stdin
  cat >"$work/$1.json"
  gcloud alpha monitoring policies create --project "$PROJECT_ID" --policy-from-file "$work/$1.json"
}

policy chain-broken <<EOF
{
  "displayName": "[Heartbeat/${PROBE_NAME}] Alerting pipeline broken",
  "combiner": "OR",
  "conditions": [{
    "displayName": "No validated heartbeat for a replica for ${ABSENT_FOR}s",
    "conditionAbsent": {
      "filter": "$(m heartbeat_probe_matched)",
      "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", ${PER_REPLICA}}],
      "duration": "${ABSENT_FOR}s",
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["${CHANNEL}"],
  "alertStrategy": {"autoClose": "1800s"},
  "documentation": {"mimeType": "text/markdown", "content": "Metrics -> Mimir -> Grafana rule -> webhook loop has not completed for the replica in the incident labels. If probe_sent logs exist for it, the stack is broken; if not, see the probe-down policy. All replicas at once = whole chain broken (incl. Grafana down)."}
}
EOF

policy probe-down <<EOF
{
  "displayName": "[Heartbeat/${PROBE_NAME}] Probe replica not sending",
  "combiner": "OR",
  "conditions": [{
    "displayName": "No probe_sent from a replica for ${ABSENT_FOR}s",
    "conditionAbsent": {
      "filter": "$(m heartbeat_probe_sent)",
      "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", ${PER_REPLICA}}],
      "duration": "${ABSENT_FOR}s",
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["${CHANNEL}"],
  "alertStrategy": {"autoClose": "1800s"}
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
      "aggregations": [{"alignmentPeriod": "1800s", "perSeriesAligner": "ALIGN_PERCENTILE_95", "crossSeriesReducer": "REDUCE_MAX", "groupByFields": ["metric.label.replica"]}],
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

echo "Done. Re-running creates duplicate policies; delete old ones first if you change them."
