# CentOS / RHEL OpenTelemetry host agent

Install **otelcol-contrib** on each CentOS Stream / RHEL / Rocky / Alma host to collect **OS metrics** and optional **file logs**, then export over **OTLP** to a central OpenTelemetry Collector.

Verified with **otelcol-contrib 0.164.0** (linux amd64).  
Release: https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.164.0

## Architecture

```
CentOS host
  otelcol-contrib (agent)
    receivers: host_metrics (incl. per-process) + file_log (optional)
    processors: memory_limiter + per-process sum (no pid) + resource/service + resource_detection + batch
    exporter:  otlp_grpc  ──►  central Collector (gateway)
                                  OTLP :4317 / :4318
                                  → your backend
```

## Quick install (recommended)

```bash
# OTLP/HTTP gateway, company root CA already in the system trust store, basic auth handed out as one token,
# package from the internal repo, host attributes from config management:
sudo COLLECTOR_ENDPOINT=https://otel-gw.corp.example:4318 \
  OTEL_AUTH_SCHEME=Basic OTEL_TOKEN="<base64 of user:password>" \
  REPO_URL=https://repo.corp.example/otel/el9/ RPM_SHA256=<sha256 of the rpm> \
  HOST_ATTRIBUTES="deployment.environment.name=prod,datacenter=sh1,team=infra,business_line=payments,role=db" \
  PROCESS_NAMES="sshd nginx" \
  bash centos-install.sh

# OTLP/gRPC, no auth (lab):
# sudo COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh

# Or use a pre-downloaded RPM (air-gapped / mirrored):
# sudo RPM_PATH=./otelcol-contrib_0.164.0_linux_amd64.rpm \
#   RPM_SHA256=<sha256 of the rpm> COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh
```

The script:

1. Gets the RPM from the internal repo (`REPO_URL`), a local file (`RPM_PATH`) or GitHub, **verifies its sha256**, and installs it via `dnf` / `yum` / `rpm`
2. Writes `/etc/otelcol-contrib/config.yaml` (host metrics + per-process metrics + file_log)
3. Writes `/etc/otelcol-contrib/otelcol-contrib.conf` (`COLLECTOR_ENDPOINT`, `KEEP_PROCESS_PIDS`, optional `OTEL_TOKEN`)
4. Writes the systemd drop-in for process metrics (see below)
5. Runs `otelcol-contrib validate` on the new config. If it fails, the previous config is restored, the running agent is left alone and the script exits 1
6. OTLP/HTTP only: **preflight** — POSTs an empty OTLP request to `<endpoint>/v1/metrics` with the same credentials and the same CA store (no proxy, like the systemd service). Anything but 2xx (401 = wrong token, certificate error = company CA missing) restores the previous config and exits 1
7. **Restarts** `otelcol-contrib` and waits 8 s; if the service is not `active` or has auto-restarted, it prints the last journal lines and exits 1

Other variables: `SERVICE_NAME` (default `centos-host`, letters/digits/`._-` only) becomes `service.name`, so logs land under that `service_name` in Loki and metrics get it as `job` in Prometheus. `ENABLE_LOGS`, `ENABLE_PROCESS_METRICS`, `PROCESS_CAPS` and `KEEP_PROCESS_PIDS` accept only `true` / `false`. Only the 5 newest `config.yaml.bak.*` / `otelcol-contrib.conf.bak.*` are kept (the conf backups contain `OTEL_TOKEN`).

### RPM integrity and work directory

The RPM is installed as root, so it is always verified before installation:

- The script works in a fresh private `mktemp -d` directory (removed on exit). `WORKDIR` is honoured only if you set it explicitly (and is then not deleted). A pre-existing RPM in a predictable path is never trusted.
- Downloaded RPMs are checked against the release's per-asset digest `${RPM_URL}.sha256`; a mismatch aborts with exit 1.
- With `REPO_URL` (internal yum repo), the repo is used for this run only (`dnf repoquery --repofrompath`, metadata cached in the work dir, **no `.repo` file is written**); the package `otelcol-contrib-<OTEL_VERSION>` is downloaded into the work dir and verified like any other RPM. A repo copy is not proof of integrity by itself, so pass `RPM_SHA256` (or let the script fetch the official digest from GitHub when it is reachable).
- With `RPM_PATH` (air-gapped), the file is copied to the private work dir and checked against `RPM_SHA256` if given; otherwise the script tries to fetch `${RPM_URL}.sha256`. If that fetch fails (offline) the install is **refused** unless you set `SKIP_RPM_VERIFY=true`, which prints a loud warning and installs unverified.

| Variable | Default | Meaning |
|----------|---------|---------|
| `RPM_SHA256` | unset | Expected sha256 (64 hex) of the RPM. Use this for offline installs |
| `REPO_URL` | unset | Internal yum repo base URL (the directory holding `repodata/`) |
| `SKIP_RPM_VERIFY` | `false` | `true` allows a `REPO_URL` / `RPM_PATH` install without any digest (insecure; only if the RPM source is otherwise trusted) |
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
- `file_log` persists its read offsets with the `file_storage` extension in `STORAGE_DIR` (default `/var/lib/otelcol-contrib/file_storage`), so lines written while the agent is stopped or the host reboots are collected once it is back. `start_at: end` only applies to files seen for the first time.
- Gateway outage: the OTLP exporter retries with backoff for up to 5 minutes per batch (in-memory queue); batches older than that are dropped. Shorter outages are replayed with original timestamps.

### Per-process metrics (`process` scraper)

CPU / memory / disk I/O of individual processes, via the `host_metrics` `process` scraper (separate from the aggregate `processes` scraper). Each process is a separate resource with `process.executable.name`, `process.executable.path`, `process.command_line`, `process.owner`, ...

Enabled metrics: `process.cpu.time`, `process.cpu.utilization` (opt-in in 0.164.0, enabled explicitly; first appears on the 2nd scrape), `process.memory.usage`, `process.memory.virtual`, `process.disk.io`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PROCESS_NAMES` | unset | Process names to collect, **space- or comma-separated** (`"rsyslogd, sshd,otelcol-contrib"`) -> `include.names`. Unset (or empty) = **all processes** |
| `PROCESS_MATCH_TYPE` | `strict` | `strict` = exact match on the process name; `regexp` = Go regexp, **unanchored** (`ssh` also matches `sshd`; use `^sshd$`) |
| `ENABLE_PROCESS_METRICS` | `true` | `false` removes the `process` scraper (and the systemd drop-in) entirely |
| `PROCESS_CAPS` | `true` | write the capability drop-in below; `false` skips `CAP_SYS_PTRACE`, so `process.disk.io` (and `executable.path`) is missing for every process not owned by the collector |

Why `strict` is the default: exact names are predictable and cheap; `regexp` is unanchored and easy to over-match. Note Linux process names (`comm`) are truncated to 15 characters, and `,`/whitespace are separators, so a regexp cannot contain them (use `|` for alternation).

```bash
# Production: pick the processes you care about
sudo -E env COLLECTOR_ENDPOINT=10.0.0.20:4317 PROCESS_NAMES="rsyslogd sshd nginx" bash centos-install.sh
# Regexp
sudo -E env COLLECTOR_ENDPOINT=... PROCESS_MATCH_TYPE=regexp PROCESS_NAMES='^java$,^postgres' bash centos-install.sh
# Off
sudo -E env COLLECTOR_ENDPOINT=... ENABLE_PROCESS_METRICS=false bash centos-install.sh
```

> **Strongly recommended: set `PROCESS_NAMES` in production.** With it unset, every process on the host is collected. Same-name processes are summed (see below), so the series count is bounded by the number of distinct executable names + owners rather than PIDs, but every short-lived command still creates its own name. That is acceptable for a lab, not for a fleet. The installer prints a warning in this mode.

**Permissions on CentOS.** The RPM service runs as the non-root user `otelcol-contrib`. On CentOS Stream 9 (verified with podman + systemd):

- `/proc/<pid>/stat|statm|cmdline` of other users are readable -> cpu time, memory, name, command line work out of the box.
- `/proc/<pid>/io` is mode `0400` **and** gated by a ptrace access check; `/proc/<pid>/exe` is gated by the ptrace check. So `process.disk.io` of other users' processes needs **both** `CAP_SYS_PTRACE` and `CAP_DAC_READ_SEARCH` (verified on a CentOS Stream 9 VM: with only `CAP_DAC_READ_SEARCH`, `process.disk.io` is missing for every process, while memory and CPU are fine).
- Without them the scraper logs `Error scraping metrics ... permission denied` every interval, for every PID (including ones your `include` would skip), so the generated config also sets `mute_process_{name,exe,io,user,cgroup}_error: true`.

The installer writes `/etc/systemd/system/otelcol-contrib.service.d/10-process-metrics.conf`:

```ini
[Service]
AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
```

This drop-in sits next to `10-read-logs.conf` (file_log, `CAP_DAC_READ_SEARCH`); systemd merges `AmbientCapabilities` / `CapabilityBoundingSet` across drop-ins, so with both enabled the service has `CAP_SYS_PTRACE` + `CAP_DAC_READ_SEARCH`. It grants the collector read access to arbitrary files (`CAP_DAC_READ_SEARCH`) and ptrace-read of other processes — a real privilege increase. If your security policy forbids it, use `PROCESS_CAPS=false` and accept missing exe path for other users' processes. `CAP_SYS_PTRACE` is close to root (it allows attaching to any process), so weigh per-process disk I/O against it: `PROCESS_CAPS=false` drops it and only loses `process.disk.io` / `executable.path` of other users' processes. With logs enabled, `10-read-logs.conf` still grants `CAP_DAC_READ_SEARCH` (read any file); for real least privilege also set `ENABLE_LOGS=false`. SELinux: verified on a CentOS Stream 9 VM (kernel 5.14, `Enforcing`): the RPM ships no SELinux policy, so the service runs as `unconfined_service_t` and SELinux does not restrict it; logs, wildcard/new files and root-process metrics all worked with 0 AVC denials. If your hosts confine it with a custom policy, check `ausearch --input-logs -m avc -ts recent` after enabling.

#### Same-name processes are summed, PIDs are stripped (default)

`process.pid` and `process.parent_pid` change on every process restart, so exporting them creates a new time series each time and blows up cardinality in the backend.
But simply deleting them makes several processes with the same name and owner (nginx / php-fpm / httpd workers, two `sleep`s...) carry identical attributes, and the backend keeps only one of them: the value is silently wrong.

So by default the metrics pipeline:

1. `transform/process_identity` copies `process.executable.name` and `process.owner` onto every `process.*` data point, aligns their timestamps, and deletes all `process.*` resource attributes (pid, parent_pid, command, command_line, executable.path)
2. `groupbyattrs/processes` regroups the points by name + owner
3. `metrics_transform/sum_processes` sums them: memory with no labels, CPU per `state`, disk I/O per `direction`

Result: one series per executable name + owner, holding the total of all matching processes (verified: three `sleep` processes of 1820 KiB RSS each -> one series of 5460 KiB).
`process.cpu.time` / `process.disk.io` are sums of cumulative counters, so when one of the processes exits the total drops and `rate()` sees a counter reset.

To see every process separately (with `process.pid`) for a debugging session, set `KEEP_PROCESS_PIDS=true`; all three steps are then skipped:

```bash
# at install time
sudo KEEP_PROCESS_PIDS=true COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh

# or on an installed host
sudo sed -i 's/^KEEP_PROCESS_PIDS=.*/KEEP_PROCESS_PIDS=true/' /etc/otelcol-contrib/otelcol-contrib.conf
sudo systemctl restart otelcol-contrib
```

Set it back to `false` (or re-run the installer without the variable, which resets it to `false`) when done.
When running `agent-config.yaml` by hand, export `KEEP_PROCESS_PIDS` in the environment; unset means `false`.

### Cardinality guards (what never leaves the host)

The agent decides what leaves the host; anything that would explode label cardinality or leak secrets is dropped at the source, not later:

| Scraper / attribute | Excluded by default | Why |
|---|---|---|
| `network` | `lo`, `veth*`, `docker*`, `br-*`, `cni*`, `cali*`, `flannel*`, `cilium*`, `lxc*`, `virbr*`, `vnet*` | per-container / per-VM interfaces get new names on every restart |
| `filesystem` | pseudo and virtual types (`tmpfs`, `overlay`, `squashfs`, `iso9660`, `proc`, `sysfs`, `cgroup2`, ...) and mount points under `/dev`, `/proc`, `/sys`, `/run`, `/var/lib/{docker,containers,kubelet}/` | one series set per container / mount |
| `disk` | `loop*`, `ram*`, `zram*`, `sr*`, `fd*` | snap/image loop devices and removable media |
| `process.*` | `pid`, `parent_pid`, `executable.path`, `command`, `command_line` (same-name processes summed) | pids churn; `command_line` can carry secrets such as `mysql -pSECRET` and is dropped even with `KEEP_PROCESS_PIDS=true` |

Real filesystems on loop or LVM devices are still reported (only the `disk` scraper skips `loop*`). To collect something excluded, edit the generated `config.yaml` (re-running the installer regenerates it).

The central collector should still enforce the same policy (drop `process.pid` / `process.command_line` and cap series per tenant), because agents in a fleet run mixed versions and can be misconfigured.

### Transport and credentials

`COLLECTOR_ENDPOINT` picks the protocol:

| `COLLECTOR_ENDPOINT` | Exporter | TLS |
|---|---|---|
| `https://gw:4318` | `otlp_http` | verified against the **system trust store** (company root CA via `update-ca-trust`); `TLS_CA_FILE` only adds a CA on top, `TLS_CERT_FILE`/`TLS_KEY_FILE` for mTLS |
| `http://gw:4318` | `otlp_http` | clear text (`TLS_CA_FILE` is rejected) |
| `gw:4317` | `otlp_grpc` | `TLS_CA_FILE` / `TLS_CERT_FILE` enable TLS, otherwise `tls.insecure: true` |

`OTEL_TOKEN` is sent as `Authorization: <OTEL_AUTH_SCHEME> <OTEL_TOKEN>`:

- `OTEL_AUTH_SCHEME=Bearer` (default): bearer token, no whitespace.
- `OTEL_AUTH_SCHEME=Basic`: the token is `base64("user:password")` as handed out by the gateway team; the installer checks that it decodes to `user:password`. When the gateway maps the basic-auth account to a tenant, nothing tenant-specific is needed on the host.

**Credentials require TLS.** With `OTEL_TOKEN` set over a clear-text connection (`http://`, or gRPC without TLS) the installer refuses with exit 1; set `TLS_INSECURE=true` explicitly to accept the risk on a trusted network or lab.

**Proxies.** The systemd service does not inherit the login shell's `http_proxy`/`https_proxy`. If your hosts set a proxy for all services (`DefaultEnvironment` in systemd), make sure the internal collector is in `NO_PROXY`, otherwise the agent's traffic goes through the proxy.

Do **not** commit tokens into git. Prefer Ansible Vault (or a secrets manager) to populate the host files below.

Where secrets land on the host:

| Secret | Location |
|--------|----------|
| CA / client certs | `/etc/otelcol-contrib/certs/` (`0640`, `root:otelcol-contrib`) |
| Token (Bearer or Basic) | `/etc/otelcol-contrib/otelcol-contrib.conf` as `OTEL_TOKEN=...` (`0640`) |
| Host attributes | same conf file as `OTEL_RESOURCE_ATTRIBUTES=...` |
| Endpoint | same conf file as `COLLECTOR_ENDPOINT=...` |

YAML references env vars (`${env:COLLECTOR_ENDPOINT}`, `${env:OTEL_TOKEN}`). Values in the conf file survive reboot because systemd loads that `EnvironmentFile`.

### Host identity and attributes (Mimir / Prometheus)

Mimir and Prometheus build the series identity of OTLP data from `service.name` → `job` and `service.instance.id` → `instance`; every other resource attribute only goes to the `target_info` series unless it is promoted. All hosts share `service.name` (`SERVICE_NAME`, default `centos-host`), so the agent sets **`service.instance.id = host.name`**: without it, hosts would overwrite each other's series in Mimir.

The agent also detects `host.id` (machine-id), `host.arch` and `os.description`, and adds `HOST_ATTRIBUTES` from config management (comma-separated `key=value`, keys `[A-Za-z0-9._-]`, values `[A-Za-z0-9._/:-]`; `service.name` / `service.instance.id` are rejected). They win over detected values.

Recommended keys and what to promote to labels in Mimir. Attributes that are constant per host do **not** add series; promoting them only makes every series' label set a little longer, so promote only what nearly every query or alert route uses:

| Attribute | Source | Promote in Mimir |
|---|---|---|
| `service.instance.id` | agent (= `host.name`) | automatic (`instance`) |
| `host.name` | detected | yes |
| `deployment.environment.name` | `HOST_ATTRIBUTES` | yes |
| `datacenter` | `HOST_ATTRIBUTES` | yes |
| `team` | `HOST_ATTRIBUTES` | yes |
| `business_line`, `role` | `HOST_ATTRIBUTES` | no: `target_info` only (a role change then re-creates one series, not all of them) |
| `host.id`, `host.arch`, `os.description` | detected | no: change with clones / patches |

Mimir (per tenant, runtime config):

```yaml
overrides:
  <tenant>:
    promote_otel_resource_attributes: "host.name,deployment.environment.name,datacenter,team"
```

Attributes left in `target_info` are joined at query time:

```promql
system_memory_utilization_ratio{state="used"}
  * on (job, instance) group_left (role, business_line) target_info{role="db"}
```

Cloned VMs keep the template's `/etc/machine-id` unless it is regenerated, so `host.id` is only unique if your image pipeline resets it.

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
      disk:          # + exclude loop/ram/sr devices, see agent-config.yaml
      filesystem:    # + exclude pseudo fs types and container mount points
      network:       # + exclude lo/veth/bridge/CNI interfaces
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
    storage: file_storage          # resume from saved offsets after a restart
    include_file_path: true

processors:
  memory_limiter: {check_interval: 1s, limit_mib: 256, spike_limit_mib: 64}
  # transform/process_identity + groupbyattrs/processes + metrics_transform/sum_processes:
  # see agent-config.yaml (sums same-name processes, strips pid)
  resource/service:
    attributes: [{key: service.name, value: centos-host, action: insert}]
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

extensions:
  file_storage: {directory: /var/lib/otelcol-contrib/file_storage, create_directory: true}

service:
  extensions: [file_storage]
  pipelines:
    metrics:
      receivers: [host_metrics]
      processors: [memory_limiter, transform/process_identity, groupbyattrs/processes, metrics_transform/sum_processes, resource/service, resource_detection, batch]
      exporters: [otlp_grpc]
    logs:
      receivers: [file_log]
      processors: [memory_limiter, resource/service, resource_detection, batch]
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
| Reading other users' `io` / `exe` as `otelcol-contrib` | Needs `CAP_SYS_PTRACE` + `CAP_DAC_READ_SEARCH` (installed by default). With `CAP_DAC_READ_SEARCH` only, `process.disk.io` is missing for all processes |
| SELinux enforcing, TLS/mTLS with process metrics | Pass (CentOS Stream 9 VM, see rows below) |
| TLS (CA only, no mTLS) + bearer token, gateway verifies both | Pass: metrics + logs arrive; wrong token -> `Unauthenticated`, wrong CA -> x509 failure |
| `ENABLE_LOGS=false` | Pass: drop-in removed (`CapEff=0`), no file_log/logs pipeline, metrics still flow |
| Container restart (systemd reboot) | Pass: service enabled, conf/certs/drop-in persist, data resumes |
| Rotation with `/var/log/myapp/*` + logrotate | Pass after fix: no `.1`/`.gz` content shipped, new active file collected |
| Gateway outage 70s / 6.5min, 4 agents | Short: replayed; long: batches older than 5 min dropped, newer replayed |
| SELinux enforcing | Pass: CentOS Stream 9 VM (Lima, `Enforcing`), service runs as `unconfined_service_t`, 0 AVC denials |
| Scraper excludes: `veth-test`, `br-test` (dummy/bridge), tmpfs, tmpfs under `/var/lib/containers`, loop device | Pass: only `eth0`, real filesystems and real disks reported; an xfs mounted from `/dev/loop0` (`/data-test`) is still reported |
| `process.command_line` / `command` | Pass: never exported, `KEEP_PROCESS_PIDS=true` included (a `-pSECRET` argument did not leave the host) |
| Same-name processes (3x `sleep`, same owner) | Pass: one series = sum of the three (5460 KiB = 3 x 1820); `KEEP_PROCESS_PIDS=true` gives three series with `process.pid` |
| Agent stopped / VM rebooted while lines are written | Pass: lines collected after restart (`file_storage` offsets) |
| Invalid generated config (`PROCESS_MATCH_TYPE=regexp PROCESS_NAMES="(sshd"`) | Pass: exit 1, old config restored, running agent untouched |
| Valid config but collector cannot start (port 8888 taken) | Pass: exit 1 with journal tail |
| `ENABLE_LOGS=yes`, `SERVICE_NAME="a b"` | Pass: rejected with exit 1 |
| mTLS (client cert) to gateway | Pass (CentOS Stream 9 VM) |
| Bearer token with `$ # ' "` over TLS | Pass; a token containing a space is rejected by the gateway (`bearertokenauth`), as RFC 6750 tokens cannot contain spaces |
| OTLP/HTTP `https://` + `Basic` token, company CA only in the system trust store (no `TLS_CA_FILE`), package from an internal repo (`REPO_URL`, createrepo over HTTP), `HOST_ATTRIBUTES` | Pass: preflight HTTP 200, metrics and logs arrive with `service.instance.id`, `host.id`, `host.arch`, `os.description` and all five host attributes; no `.repo` file left behind |
| Preflight: wrong password / no token / CA removed from trust store | Pass: 401 / 401 / certificate error, exit 1, previous config and running agent untouched |
| Invalid input: Basic token not base64 or without `:`, `http://` + token, `http://` + `TLS_CA_FILE`, `grpc://` URL, bad `HOST_ATTRIBUTES`, `service.name` in `HOST_ATTRIBUTES`, version missing in `REPO_URL` | Pass: exit 1 before anything is changed |
| gRPC regression to Prometheus | Pass: `instance="lima-otel-cs9"`, `job="centos-host"` |
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
