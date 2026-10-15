# heartbeat-probe: end-to-end alerting pipeline probe

Continuously verifies that the whole path "metric ingest → Nginx → OTel Collector → Mimir → Grafana rule evaluation → webhook notification" works, and raises alerts on GCP when the path breaks, when the probe itself stops, or when it gets slow. Runs with multiple replicas.

```mermaid
flowchart LR
  subgraph K8S["GKE: heartbeat-probe StatefulSet"]
    R0["replica 0"]
    R1["replica 1"]
  end

  subgraph STACK["Observability stack under test"]
    NG["Nginx<br/>Basic auth"] --> OC["OTel Collector"] --> MM["Mimir"] --> GR["Grafana rule<br/>one alert instance per replica"]
  end

  subgraph GCP["GCP: independent judge"]
    CL["Cloud Logging"] --> LM["Log-based metrics<br/>label: replica"] --> CM["Cloud Monitoring<br/>alert policies"]
  end

  R0 -- "OTLP: state, id, self metrics" --> NG
  R1 -- "OTLP: state, id, self metrics" --> NG
  GR -- "webhook: probe_id, replica" --> SVC["Service /webhook<br/>load-balanced"]
  SVC --> R0
  SVC --> R1
  R0 -. "stdout JSON logs" .-> CL
  R1 -. "stdout JSON logs" .-> CL
  CM --> ONCALL["On-call channel<br/>independent of the stack"]
```

## How it works

| Time (defaults) | What happens |
|---|---|
| Every 300 s | Each replica starts a new probe; `probe_id` = cycle start (epoch seconds, aligned to the period) |
| First 120 s | `heartbeat_probe_state{replica}=1`; Grafana fires for that replica and the webhook echoes `probe_id` |
| Remaining 180 s | `heartbeat_probe_state{replica}=0`; the alert resolves and the webhook sends `resolved` |

One probe cycle, with the notification landing on a different replica than the sender:

```mermaid
sequenceDiagram
  autonumber
  participant R0 as Replica 0 (sender)
  participant P as Nginx, Collector, Mimir
  participant G as Grafana rule
  participant R1 as Replica 1 (receiver)
  participant L as GCP Cloud Logging

  Note over R0: t = probe_id (cycle start)
  R0->>L: probe_sent (replica 0, probe_id)
  loop every 15 s while firing
    R0->>P: OTLP state=1, id=probe_id
  end
  loop every 30 s
    G->>P: query state and id per replica
  end
  P-->>G: replica 0 state is 1 and fresh
  G->>R1: webhook firing (probe_id, replica 0)
  Note over R1: validate window, latency = now - probe_id
  R1->>L: alert_received firing, matched=true, latency
  Note over R0: t = probe_id + 120 s
  R0->>L: probe_cleared
  R0->>P: OTLP state=0
  P-->>G: replica 0 state is 0
  G->>R1: webhook resolved (probe_id, replica 0)
  R1->>L: alert_received resolved, matched=true, latency
```

### Multiple replicas: stateless pairing

The webhook goes through a Service and can land on any replica, so pairing does not rely on in-process memory:

- `probe_id` *is* the probe start time, so the receiver computes end-to-end latency as `now − probe_id`.
- Validation: `probe_id` must be aligned to the period and inside the timeout window (not too old, not from the future). Anything else is logged as `matched=false` with a reason.
- `replica` in the log is the replica that **sent** the probe (taken from the alert labels); `received_by` is the replica that actually received the webhook.
- Timeouts are not detected by the service itself. GCP detects them per replica as "no validated heartbeat for a while".

How a received notification is validated (every outcome is logged and counted in `heartbeat.probe.notifications`):

```mermaid
flowchart TD
  A["Webhook alert"] --> B{"probe label matches?"}
  B -- no --> X["Ignore"]
  B -- yes --> C{"probe_id parses?"}
  C -- no --> F1["matched=false<br/>missing_or_bad_probe_id"]
  C -- yes --> D{"status is firing or resolved?"}
  D -- no --> F2["matched=false<br/>unknown_status"]
  D -- yes --> E{"probe_id aligned to period?"}
  E -- no --> F3["matched=false<br/>probe_id_not_aligned"]
  E -- yes --> L["latency = now - reference<br/>firing: reference = probe_id<br/>resolved: reference = probe_id + firing"]
  L --> G{"more than 60 s in the future?"}
  G -- yes --> F4["matched=false<br/>from_future"]
  G -- no --> H{"older than the timeout?"}
  H -- yes --> F5["matched=false<br/>late"]
  H -- no --> I{"already seen on this replica?"}
  I -- yes --> F6["matched=false<br/>duplicate"]
  I -- no --> OK["matched=true<br/>latency recorded"]
```

### Log events (`jsonPayload.event`)

| Event | Meaning |
|---|---|
| `probe_sent` | Replica entered the firing phase (`replica` = itself) |
| `probe_cleared` | Replica entered the resolve phase |
| `alert_received` | Webhook received; fields `status`, `matched`, `latency_seconds`, `reason`, `replica`, `received_by` |
| `webhook_unauthorized` | Webhook authentication failed |

`reason` values: `late` (arrived after the timeout), `from_future`, `probe_id_not_aligned` (ID lost precision in formatting), `missing_or_bad_probe_id`, `unknown_status`, `duplicate` (the same replica received a repeat notification; best effort only).

### Self-observability metrics (standard OTel SDK)

The probe exports its own operational metrics over the same OTLP endpoint so you can review how it is doing in Grafana. Resource attributes include `service.name=heartbeat-probe` and `service.instance.id=<replica name>`.

| OTel metric | Type | Attributes | Name in Mimir (default translation) |
|---|---|---|---|
| `heartbeat.probe.sent` | Counter | probe, replica | `heartbeat_probe_sent_total` |
| `heartbeat.probe.notifications` | Counter | probe, replica (sender), received_by, status, matched, reason | `heartbeat_probe_notifications_total` |
| `heartbeat.probe.latency` | Histogram (seconds) | probe, replica, status | `heartbeat_probe_latency_seconds_bucket`, etc. |
| `heartbeat.probe.webhook.rejected` | Counter | probe, received_by, reason | `heartbeat_probe_webhook_rejected_total` |

Example queries (adjust names to what your Mimir translation actually produces):

```promql
# Validated heartbeats per replica per hour (expect about 3600/300 = 12)
sum by (replica) (increase(heartbeat_probe_notifications_total{matched="true", status="firing"}[1h]))

# End-to-end latency p95
histogram_quantile(0.95, sum by (le, replica) (rate(heartbeat_probe_latency_seconds_bucket{status="firing"}[1h])))

# Why pairing failed
sum by (reason) (increase(heartbeat_probe_notifications_total{matched="false"}[1d]))
```

These metrics travel through the very path being tested. **Use them for review and analysis only, not to decide whether the path is broken**: when the path breaks they disappear too. That decision is made on GCP.

### GCP alerts (created by `gcp/setup.sh`, each fires per replica)

| Alert | Condition | What it catches |
|---|---|---|
| Alerting pipeline broken | No validated heartbeat for a replica within 15 min | That replica's path is broken; all replicas at once = the whole path is broken (including Grafana being down) |
| Probe replica not sending | No `probe_sent` from a replica within 15 min | The probe replica itself is down |
| Alerting pipeline slow | End-to-end latency p95 > 180 s | The path works but is badly degraded |

How failures surface. The design rule is that every failure turns into *silence*, and GCP alerts on silence:

```mermaid
flowchart LR
  F1["Ingest broken<br/>Nginx or Collector"] --> S
  F2["Mimir write or query fails"] --> S
  F3["Rule error or no data<br/>execErrState and noDataState = OK"] --> S
  F4["Grafana down"] --> S
  F5["Webhook delivery fails"] --> S
  S["No validated heartbeat<br/>for the affected replicas"] --> A1["GCP: Alerting pipeline broken"]
  D["Probe replica down"] --> N["No probe_sent from that replica"] --> A2["GCP: Probe replica not sending"]
  SL["Path works but slow"] --> A3["GCP: Alerting pipeline slow"]
  A1 --> P["Page on-call"]
  A2 --> P
  A3 --> P
```

## Deployment

1. **Build the image**: `docker build -t REGISTRY/heartbeat-probe:1.1.0 .`
2. **Deploy to GKE**: set the OTLP endpoint, team credential and webhook token in `k8s/deployment.yaml`, then `kubectl apply -f k8s/`.
   - Uses a **StatefulSet**: replica names are stable (`heartbeat-probe-0`, `-1`), so Mimir series and the per-replica GCP alerts survive restarts.
   - Logs go to stdout and GKE ships them to Cloud Logging. **They must not go through your own OTel/Loki pipeline.**
   - Make the `heartbeat-probe` Service's `/webhook` reachable from the Grafana alerting instances (internal load balancer or Ingress).
3. **Grafana**: put `grafana/*.yaml` into the provisioning/alerting directory.
   - Replace `MIMIR_DATASOURCE_UID` with the datasource for the probe's tenant.
   - Set the `HEARTBEAT_WEBHOOK_TOKEN` environment variable on Grafana.
4. **GCP**: `PROJECT_ID=... CHANNEL_ID=... ./gcp/setup.sh`. The notification channel must be independent of the system being monitored.

## Pre-launch checklist

- **Metric names in Mimir**: OTel `heartbeat.probe.state` / `heartbeat.probe.id` translate to `heartbeat_probe_state` / `heartbeat_probe_id` by default. If your translation adds suffixes, update the queries in `alert-rule.yaml`.
- **`$values.B.Value` resolves**: preview the annotation in the Grafana rule editor and confirm each replica's alert instance gets its own ID. If it does not, add a Reduce expression D (last of B) and use `$values.D.Value`.
- **Keep `printf "%.0f"`**: default formatting renders `1.76054e+09`, which loses precision and is rejected as `probe_id_not_aligned` (never counted as success).
- **`notification_settings`** requires a Grafana version with per-rule notification settings. Otherwise remove that block and add a child policy in the UI: match `probe=e2e`, send to `heartbeat-probe-webhook`, group_by including `replica`, group_wait 0s, group_interval 30s.
- **`noDataState` / `execErrState` must be OK**: any failure must show up as *no notification*, so GCP detects the gap, rather than as a fake notification.
- **Replica clocks must be in sync** (NTP): pairing uses a time window with 60 s tolerance.

## Operations

- **Scaling down raises an alert**: the removed replica's heartbeat disappears and GCP fires one "broken" alert for it. This is expected; snooze it before scaling down. Scaling up is fine.
- **Duplicate notifications**: if Grafana's cross-instance de-duplication fails, several replicas may each receive the same notification. Counts on GCP will be higher, but they are only used to check presence, so alerting is unaffected.

## Post-launch drills

1. Delete one replica's Pod → expect no alert (the StatefulSet recreates it with the same name); if it does not come back, expect *Probe replica not sending*.
2. Pause the rule in Grafana → expect *Alerting pipeline broken* for every replica.
3. Temporarily drop `heartbeat_probe_*` in the Collector → same as above.
4. Record the time from each failure to the GCP alert as the baseline for the alerting path.

## Local tests

```bash
pip install -r requirements.txt pytest
python -m pytest -q tests
```

The integration test starts two replicas and a fake OTLP receiver (decoding protobuf), delivers replica 0's notification to replica 1, and checks cross-replica pairing, the `replica` attribute, self-observability metrics, the credential header and authentication.
