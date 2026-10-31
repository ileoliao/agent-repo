# CentOS / RHEL OpenTelemetry host agent

Install **otelcol-contrib** on each CentOS Stream / RHEL / Rocky / Alma host to collect **OS metrics** and optional **file logs**, then export over **OTLP** to a central OpenTelemetry Collector.

Verified with **otelcol-contrib 0.164.0** (linux amd64).  
Release: https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.164.0

## Architecture

```
CentOS host
  otelcol-contrib (agent)
    receivers: host_metrics (incl. per-process) + file_log (optional)
    processors: memory_limiter + transform (drop process.pid / parent_pid) + resource_detection + batch
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
#   RPM_SHA256=<sha256 of the rpm> COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh
```

The script:

1. Downloads (or uses `RPM_PATH`), **verifies its sha256**, and installs the contrib RPM via `dnf` / `yum` / `rpm`
2. Writes `/etc/otelcol-contrib/config.yaml` (host metrics + per-process metrics + file_log)
3. Writes `/etc/otelcol-contrib/otelcol-contrib.conf` (`COLLECTOR_ENDPOINT`, `KEEP_PROCESS_PIDS`, optional `OTEL_TOKEN`)
4. Writes the systemd drop-in for process metrics (see below) and **restarts** `otelcol-contrib`

### RPM integrity and work directory

The RPM is installed as root, so it is always verified before installation:

- The script works in a fresh private `mktemp -d` directory (removed on exit). `WORKDIR` is honoured only if you set it explicitly (and is then not deleted). A pre-existing RPM in a predictable path is never trusted.
- Downloaded RPMs are checked against the release's per-asset digest `${RPM_URL}.sha256`; a mismatch aborts with exit 1.
- With `RPM_PATH` (air-gapped), the file is copied to the private work dir and checked against `RPM_SHA256` if given; otherwise the script tries to fetch `${RPM_URL}.sha256`. If that fetch fails (offline) the install is **refused** unless you set `SKIP_RPM_VERIFY=true`, which prints a loud warning and installs unverified.

| Variable | Default | Meaning |
|----------|---------|---------|
| `RPM_SHA256` | unset | Expected sha256 (64 hex) of the RPM. Use this for offline installs |
| `SKIP_RPM_VERIFY` | `false` | `true` allows an `RPM_PATH` install without any digest (insecure; only if the RPM source is otherwise trusted) |
| `WORKDIR` | fresh `mktemp -d` | Override the work directory (not cleaned up) |

```bash
sudo RPM_PATH=./otelcol-contrib_0.164.0_linux_amd64.rpm \
  RPM_SHA256=c79d8f9faea63c43265ea027f3c7c6e72f42d1a54e90be6b8d1fe531b1ad8fdc \
  COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh
```

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

### Per-process metrics (`process` scraper)

CPU / memory / disk I/O of individual processes, via the `host_metrics` `process` scraper (separate from the aggregate `processes` scraper). Each process is a separate resource with `process.executable.name`, `process.executable.path`, `process.command_line`, `process.owner`, ...

Enabled metrics: `process.cpu.time`, `process.cpu.utilization` (opt-in in 0.164.0, enabled explicitly; first appears on the 2nd scrape), `process.memory.usage`, `process.memory.virtual`, `process.disk.io`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PROCESS_NAMES` | unset | Process names to collect, **space- or comma-separated** (`"rsyslogd, sshd,otelcol-contrib"`) -> `include.names`. Unset (or empty) = **all processes** |
| `PROCESS_MATCH_TYPE` | `strict` | `strict` = exact match on the process name; `regexp` = Go regexp, **unanchored** (`ssh` also matches `sshd`; use `^sshd$`) |
| `ENABLE_PROCESS_METRICS` | `true` | `false` removes the `process` scraper (and the systemd drop-in) entirely |
| `PROCESS_CAPS` | `true` | write the capability drop-in below; `false` skips `CAP_SYS_PTRACE`, so root processes lose `executable.path`; `process.disk.io` is still readable while `ENABLE_LOGS=true` (see below) |

Why `strict` is the default: exact names are predictable and cheap; `regexp` is unanchored and easy to over-match. Note Linux process names (`comm`) are truncated to 15 characters, and `,`/whitespace are separators, so a regexp cannot contain them (use `|` for alternation).

```bash
# Production: pick the processes you care about
sudo -E env COLLECTOR_ENDPOINT=10.0.0.20:4317 PROCESS_NAMES="rsyslogd sshd nginx" bash centos-install.sh
# Regexp
sudo -E env COLLECTOR_ENDPOINT=... PROCESS_MATCH_TYPE=regexp PROCESS_NAMES='^java$,^postgres' bash centos-install.sh
# Off
sudo -E env COLLECTOR_ENDPOINT=... ENABLE_PROCESS_METRICS=false bash centos-install.sh
```

> **Strongly recommended: set `PROCESS_NAMES` in production.** With it unset, every process on the host is collected (one resource and ~5 metrics series per PID per interval; short-lived processes keep creating new series). That is acceptable for a lab, not for a fleet. The installer prints a warning in this mode.

**Permissions on CentOS.** The RPM service runs as the non-root user `otelcol-contrib`. On CentOS Stream 9 (verified with podman + systemd):

- `/proc/<pid>/stat|statm|cmdline` of other users are readable -> cpu time, memory, name, command line work out of the box.
- `readlink /proc/<pid>/exe` needs `CAP_SYS_PTRACE`; `/proc/<pid>/io` is root-only `0400` and needs `CAP_DAC_READ_SEARCH`. **Both** are needed for `process.disk.io` and `process.executable.path` of root-owned processes (`CAP_SYS_PTRACE` alone still fails on `/proc/<pid>/io`).
- Without them the scraper logs `Error scraping metrics ... permission denied` every interval, for every PID (including ones your `include` would skip), so the generated config also sets `mute_process_{name,exe,io,user,cgroup}_error: true`.

The installer writes `/etc/systemd/system/otelcol-contrib.service.d/10-process-metrics.conf`:

```ini
[Service]
AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
```

This drop-in sits next to `10-read-logs.conf` (file_log, `CAP_DAC_READ_SEARCH`); systemd merges `AmbientCapabilities` / `CapabilityBoundingSet` across drop-ins, so with both enabled the service has `CAP_SYS_PTRACE` + `CAP_DAC_READ_SEARCH`. It grants the collector read access to arbitrary files (`CAP_DAC_READ_SEARCH`) and ptrace-read of other processes — a real privilege increase. If your security policy forbids it, use `PROCESS_CAPS=false` and accept missing exe path for other users' processes. Note that `PROCESS_CAPS=false` alone is **not** least privilege: with logs enabled (the default) the `10-read-logs.conf` drop-in still grants `CAP_DAC_READ_SEARCH` (read any file), which is the broader capability, so root processes' `process.disk.io` stays readable and only `CAP_SYS_PTRACE` / `executable.path` is lost. For real least privilege set `PROCESS_CAPS=false` **and** `ENABLE_LOGS=false` (then `process.disk.io` and `executable.path` of root processes are both missing). SELinux: verified on a CentOS Stream 9 VM (kernel 5.14, `Enforcing`): the RPM ships no SELinux policy, so the service runs as `unconfined_service_t` and SELinux does not restrict it; logs, wildcard/new files and root-process metrics all worked with 0 AVC denials. If your hosts confine it with a custom policy, check `ausearch --input-logs -m avc -ts recent` after enabling.

#### PIDs are stripped by default

`process.pid` and `process.parent_pid` change on every process restart, so exporting them creates a new time series each time and blows up cardinality in the backend.
The agent therefore runs a `transform/drop_process_pids` processor at the start of the metrics pipeline that deletes these two resource attributes before the OTLP export.
Stable attributes are kept: `process.executable.name`, `process.executable.path`, `process.command`, `process.command_line`, `process.owner`, plus `host.name` / `os.type`.

To keep the PIDs for a debugging session, set `KEEP_PROCESS_PIDS=true`:

```bash
# at install time
sudo KEEP_PROCESS_PIDS=true COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh

# or on an installed host
sudo sed -i 's/^KEEP_PROCESS_PIDS=.*/KEEP_PROCESS_PIDS=true/' /etc/otelcol-contrib/otelcol-contrib.conf
sudo systemctl restart otelcol-contrib
```

Set it back to `false` (or re-run the installer without the variable, which resets it to `false`) when done.
When running `agent-config.yaml` by hand, export `KEEP_PROCESS_PIDS` in the environment; unset means `false`.

Caveats:

- Without the PID, processes that share the same executable/command line/owner (e.g. several `nginx` workers matched by `PROCESS_NAMES`) produce identical resource attributes, so their series
  collapse into one. Per-process values are only meaningful for singleton processes; aggregate per executable name in the backend or gateway if you need totals.
- `process.command_line` is kept because it is stable per service, but it can still be high cardinality for processes launched with changing arguments.
  Delete it in the same processor if that is a problem on your hosts.

### Credentials (TLS / token)

Do **not** commit tokens into git. Prefer Ansible Vault (or a secrets manager) to populate the host files below.

```bash
export COLLECTOR_ENDPOINT=otel-gateway.corp:4317
export TLS_CA_FILE=/path/ca.crt              # enables TLS verify (insecure=false by default when CA is set)
# export TLS_CERT_FILE=/path/client.crt      # optional mTLS
# export TLS_KEY_FILE=/path/client.key
# export OTEL_TOKEN='your-bearer-token'      # optional Authorization header; requires TLS (see below)
# export TLS_INSECURE=false
sudo -E bash centos-install.sh
```

**Bearer token requires TLS.** If `OTEL_TOKEN` is set while TLS is not configured (no `TLS_CA_FILE` / `TLS_CERT_FILE`, so `tls.insecure` would be `true`), the installer refuses with exit 1, because the token would be sent in clear text. To accept that risk on a trusted network or lab, set `TLS_INSECURE=true` explicitly; the installer then prints a warning and continues.

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
      processes:                 # aggregate counts
      process:                   # per-process; prefer an include list in production
        include:
          match_type: strict     # or regexp
          names: [rsyslogd, sshd, otelcol-contrib]
        mute_process_name_error: true
        mute_process_exe_error: true
        mute_process_io_error: true
        mute_process_user_error: true
        mute_process_cgroup_error: true
        metrics:
          process.cpu.time: {enabled: true}
          process.cpu.utilization: {enabled: true}
          process.memory.usage: {enabled: true}
          process.memory.virtual: {enabled: true}
          process.disk.io: {enabled: true}
  file_log:
    include:
      - /var/log/messages
      - /var/log/secure
    start_at: end
    include_file_path: true

processors:
  transform/drop_process_pids:
    error_mode: ignore
    metric_statements:
      - context: resource
        statements:
          - 'delete_key(resource.attributes, "process.pid") where "${env:KEEP_PROCESS_PIDS:-false}" != "true"'
          - 'delete_key(resource.attributes, "process.parent_pid") where "${env:KEEP_PROCESS_PIDS:-false}" != "true"'
  memory_limiter: {check_interval: 1s, limit_mib: 256, spike_limit_mib: 64}
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
      processors: [memory_limiter, transform/drop_process_pids, resource_detection, batch]
      exporters: [otlp_grpc]
    logs:
      receivers: [file_log]
      processors: [memory_limiter, resource_detection, batch]
      exporters: [otlp_grpc]
```

See also `agent-config.yaml` and the config generated by `centos-install.sh`.

## Gateway (minimal)

`gateway-config.yaml` receives OTLP **metrics and logs** (both pipelines are required; without a `logs` pipeline the agent gets `Unimplemented ... LogsService` and drops every log batch) and prints with the `debug` exporter. In production, replace `debug` with Prometheus remote_write / OTLP / Kafka / etc.

It listens on `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP) and writes to `./logs/gateway-{metrics,logs}.json` relative to the working directory (run it from this folder). It is a **verification gateway with no authentication**: do not expose it to the public internet.

Allow **4317/tcp** (gRPC) or **4318/tcp** (HTTP) from agents to the gateway.

## Verification status

| Check | Result |
|-------|--------|
| Binary pipeline agent → gateway (host metrics) | Pass (0.164.0) |
| CentOS Stream 9 + RPM + systemd (`centos-install.sh`) | Pass (Cursor VM + podman) |
| TLS with CA to gateway | Pass |
| Bearer token written to conf | Pass (gateway did not enforce auth in lab) |
| Process metrics without `process.pid` / `process.parent_pid` (default) | Pass: CentOS Stream 9 + podman + systemd, installer-generated config; no pid attributes at gateway, `process.executable.name`/`command`/`owner` present |
| `KEEP_PROCESS_PIDS=true` (conf edit + restart) | Pass: pid and parent_pid present again after restart |
| Per-process metrics, filtered (`PROCESS_NAMES="rsyslogd, sshd,otelcol-contrib"`, strict) | Pass — CentOS Stream 9 + systemd + podman; `process.cpu.time/utilization`, `process.memory.usage/virtual`, `process.disk.io` seen at gateway with `process.pid` / `process.executable.name` |
| `PROCESS_MATCH_TYPE=regexp` | Pass (`^ssh,rsyslog` -> sshd, rsyslogd only) |
| `ENABLE_PROCESS_METRICS=false` | Pass (no process scraper, drop-in removed) |
| `PROCESS_NAMES` unset (all processes) | Pass (lab smoke; installer warns) |
| Reading root processes' `io` / `exe` as `otelcol-contrib` | Needs `CAP_SYS_PTRACE` + `CAP_DAC_READ_SEARCH` drop-in (installed by default, `PROCESS_CAPS=false` to skip) |
| SELinux enforcing, TLS/mTLS with process metrics | Not tested |
| TLS (CA only, no mTLS) + bearer token, gateway verifies both | Pass: metrics + logs arrive; wrong token -> `Unauthenticated`, wrong CA -> x509 failure |
| `ENABLE_LOGS=false` | Pass: drop-in removed (`CapEff=0`), no file_log/logs pipeline, metrics still flow |
| Container restart (systemd reboot) | Pass: service enabled, conf/certs/drop-in persist, data resumes |
| Rotation with `/var/log/myapp/*` + logrotate | Pass after fix: no `.1`/`.gz` content shipped, new active file collected |
| Gateway outage 70s / 6.5min, 4 agents | Short: replayed; long: batches older than 5 min dropped, newer replayed |
| SELinux enforcing | Not tested (lab VM has no SELinux policy loaded) |
| Live filelog (`file_log`) CentOS Stream 9 + podman + systemd, agent -> gateway | Pass: lines from `/var/log/messages`, `/var/log/secure`, `/var/log/myapp/*.log` (incl. file created after install) seen at gateway; works after logrotate |

Raw samples and permission experiments: [`evidence/process-metrics-centos9.md`](evidence/process-metrics-centos9.md).

Sample metric names observed: `system.cpu.utilization`, `system.memory.usage`, `system.disk.io`, `system.filesystem.usage`, `system.network.io`, `system.cpu.load_average.*`, `system.paging.*`, `system.processes.*`, `process.cpu.time`, `process.cpu.utilization`, `process.memory.usage`, `process.memory.virtual`, `process.disk.io`.

## Files in this folder

| Path | Description |
|------|-------------|
| `centos-install.sh` | one-shot CentOS/RHEL installer |
| `agent-config.yaml` | production-oriented agent config |
| `agent-config.lab.yaml` | local lab agent (127.0.0.1) |
| `gateway-config.yaml` | minimal gateway |
| `run-lab.sh` | local smoke test helper (needs `./bin/otelcol-contrib`, not in the repo) |
| `evidence/` | live verification output (per-process metrics on CentOS Stream 9) |
