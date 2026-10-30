# CentOS / RHEL OpenTelemetry host agent

Install **otelcol-contrib** on each CentOS Stream / RHEL / Rocky / Alma host to collect **OS metrics** and optional **file logs**, then export over **OTLP** to a central OpenTelemetry Collector.

Verified with **otelcol-contrib 0.164.0** (linux amd64).  
Release: https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.164.0

## Architecture

```
CentOS host
  otelcol-contrib (agent)
    receivers: host_metrics + filelog (optional)
    processors: resource_detection + batch
    exporter:  otlp_grpc  ──►  central Collector (gateway)
                                  OTLP :4317 / :4318
                                  → your backend
```

## Quick install (recommended)

```bash
export COLLECTOR_ENDPOINT=10.0.0.20:4317
sudo bash centos-install.sh

# Or use a pre-downloaded RPM (air-gapped / mirrored):
# sudo RPM_PATH=./otelcol-contrib_0.164.0_linux_amd64.rpm \
#   COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh
```

The script:

1. Downloads (or uses `RPM_PATH`) and installs the contrib RPM via `dnf` / `yum` / `rpm`
2. Writes `/etc/otelcol-contrib/config.yaml` (host metrics + filelog)
3. Writes `/etc/otelcol-contrib/otelcol-contrib.conf` (`COLLECTOR_ENDPOINT`, optional `OTEL_TOKEN`)
4. Enables and **restarts** `otelcol-contrib` via systemd

### File logs (enabled by default)

Default paths:

- `/var/log/messages`
- `/var/log/secure`

```bash
export LOG_PATHS="/var/log/messages /var/log/secure /var/log/myapp/*.log"
# Metrics only:
# export ENABLE_LOGS=false
```

The script adds the `otelcol-contrib` user to the `adm` group, **and** installs a systemd drop-in
`/etc/systemd/system/otelcol-contrib.service.d/10-read-logs.conf` granting `CAP_DAC_READ_SEARCH`.
The drop-in is required on CentOS/RHEL: `/var/log/messages` and `/var/log/secure` are `root:root 0600`, so `adm` alone
gives `open /var/log/messages: permission denied`. The capability survives logrotate re-creating the files.
`LOG_PATHS` globs (e.g. `/var/log/myapp/*.log`) are written to the config unexpanded, so files created later are picked up.
Rotated files are excluded with `**/*.gz` and `**/*.[0-9]` (any directory), so a broad glob such as `/var/log/myapp/*` does not re-ship `app.log.1` / `app.log.2.gz`.

Notes from live testing:

- **journald-only hosts** (no `rsyslog`): `/var/log/messages` and `/var/log/secure` do not exist, `file_log` stays silent (no error) and no logs are shipped; metrics still work. Install/enable `rsyslog`, or replace the receiver with `journald` (add `otelcol-contrib` to the `systemd-journal` group).
- The agent's own stdout goes to journald -> rsyslog -> `/var/log/messages`, so its own log lines are shipped too. During a gateway outage this adds retry/error lines to the stream.
- `file_log` has no offset storage and uses `start_at: end`: lines written while the agent is stopped/rebooting are not collected afterwards.
- Gateway outage: the OTLP exporter retries with backoff for up to 5 minutes per batch (in-memory queue); batches older than that are dropped. Shorter outages are replayed with original timestamps.

### Credentials (TLS / token)

Do **not** commit tokens into git. Prefer Ansible Vault (or a secrets manager) to populate the host files below.

```bash
export COLLECTOR_ENDPOINT=otel-gateway.corp:4317
export TLS_CA_FILE=/path/ca.crt              # enables TLS verify (insecure=false by default when CA is set)
# export TLS_CERT_FILE=/path/client.crt      # optional mTLS
# export TLS_KEY_FILE=/path/client.key
# export OTEL_TOKEN='your-bearer-token'      # optional Authorization header
# export TLS_INSECURE=false
sudo -E bash centos-install.sh
```

Where secrets land on the host:

| Secret | Location |
|--------|----------|
| CA / client certs | `/etc/otelcol-contrib/certs/` (`0640`, `root:otelcol-contrib`) |
| Bearer token | `/etc/otelcol-contrib/otelcol-contrib.conf` as `OTEL_TOKEN=...` (`0640`) |
| Endpoint | same conf file as `COLLECTOR_ENDPOINT=...` |

YAML references env vars (`${env:COLLECTOR_ENDPOINT}`, `${env:OTEL_TOKEN}`). Values in the conf file survive reboot because systemd loads that `EnvironmentFile`.

### Ansible note

Keep secrets in Ansible Vault (or HashiCorp Vault / KMS). The playbook should template `otelcol-contrib.conf` and copy cert files with mode `0640` — same layout as the install script. A transient shell `export` is **not** enough after crash/reboot.

## Manual RPM install

```bash
VER=0.164.0
curl -fLO "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${VER}/otelcol-contrib_${VER}_linux_amd64.rpm"
sudo dnf install -y ./otelcol-contrib_${VER}_linux_amd64.rpm
# or: sudo rpm -ivh ./otelcol-contrib_${VER}_linux_amd64.rpm
```

Package paths:

| Path | Purpose |
|------|---------|
| `/usr/bin/otelcol-contrib` | binary |
| `/etc/otelcol-contrib/config.yaml` | main config (replace RPM demo config) |
| `/etc/otelcol-contrib/otelcol-contrib.conf` | systemd env (`OTELCOL_OPTIONS`, secrets) |
| `/lib/systemd/system/otelcol-contrib.service` | runs as user `otelcol-contrib` |

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now otelcol-contrib
sudo journalctl -u otelcol-contrib -f
```

## Agent config sketch

Component names for 0.164.0+: `host_metrics`, `file_log`, `resource_detection`, `otlp_grpc` (old aliases such as `filelog` still work but warn).

```yaml
receivers:
  host_metrics:
    collection_interval: 30s
    scrapers:
      cpu:
        metrics:
          system.cpu.utilization:
            enabled: true
      memory:
        metrics:
          system.memory.utilization:
            enabled: true
      disk:
      filesystem:
      network:
      load:
      paging:
      processes:
  file_log:
    include:
      - /var/log/messages
      - /var/log/secure
    start_at: end
    include_file_path: true

processors:
  resource_detection:
    detectors: [system, env]
    system:
      hostname_sources: [os]
  batch: {}

exporters:
  otlp_grpc:
    endpoint: ${env:COLLECTOR_ENDPOINT}
    tls:
      insecure: true   # production: CA / mTLS

service:
  pipelines:
    metrics:
      receivers: [host_metrics]
      processors: [resource_detection, batch]
      exporters: [otlp_grpc]
    logs:
      receivers: [file_log]
      processors: [resource_detection, batch]
      exporters: [otlp_grpc]
```

See also `agent-config.yaml` and the config generated by `centos-install.sh`.

## Gateway (minimal)

`gateway-config.yaml` receives OTLP **metrics and logs** (both pipelines are required; without a `logs` pipeline the agent gets `Unimplemented ... LogsService` and drops every log batch) and prints with the `debug` exporter. In production, replace `debug` with Prometheus remote_write / OTLP / Kafka / etc.

Allow **4317/tcp** (gRPC) or **4318/tcp** (HTTP) from agents to the gateway.

## Verification status

| Check | Result |
|-------|--------|
| Binary pipeline agent → gateway (host metrics) | Pass (0.164.0) |
| CentOS Stream 9 + RPM + systemd (`centos-install.sh`) | Pass (Cursor VM + podman) |
| TLS with CA to gateway | Pass |
| Bearer token written to conf | Pass (gateway did not enforce auth in lab) |
| TLS (CA only, no mTLS) + bearer token, gateway verifies both | Pass: metrics + logs arrive; wrong token -> `Unauthenticated`, wrong CA -> x509 failure |
| `ENABLE_LOGS=false` | Pass: drop-in removed (`CapEff=0`), no file_log/logs pipeline, metrics still flow |
| Container restart (systemd reboot) | Pass: service enabled, conf/certs/drop-in persist, data resumes |
| Rotation with `/var/log/myapp/*` + logrotate | Pass after fix: no `.1`/`.gz` content shipped, new active file collected |
| Gateway outage 70s / 6.5min, 4 agents | Short: replayed; long: batches older than 5 min dropped, newer replayed |
| SELinux enforcing | Not tested (lab VM has no SELinux policy loaded) |
| Live filelog (`file_log`) CentOS Stream 9 + podman + systemd, agent -> gateway | Pass: lines from `/var/log/messages`, `/var/log/secure`, `/var/log/myapp/*.log` (incl. file created after install) seen at gateway; works after logrotate |

Sample metric names observed: `system.cpu.utilization`, `system.memory.usage`, `system.disk.io`, `system.filesystem.usage`, `system.network.io`, `system.cpu.load_average.*`, `system.paging.*`, `system.processes.*`.

## Files in this folder

| Path | Description |
|------|-------------|
| `centos-install.sh` | one-shot CentOS/RHEL installer |
| `agent-config.yaml` | production-oriented agent config |
| `agent-config.lab.yaml` | local lab agent (127.0.0.1) |
| `gateway-config.yaml` | minimal gateway |
| `run-lab.sh` | local smoke test helper |
