# CentOS / RHEL OpenTelemetry host agent

Install **otelcol-contrib** on each CentOS Stream / RHEL / Rocky / Alma host to collect **OS metrics** and optional **file logs**, then export over **OTLP** to a central OpenTelemetry Collector.

Verified with **otelcol-contrib 0.164.0** (linux amd64).  
Release: https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.164.0

## Architecture

```
CentOS host
  otelcol-contrib (agent)
    receivers: host_metrics (incl. per-process) + journald (optional) + file_log (optional)
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
  OTEL_AUTH_SCHEME=Basic OTEL_TOKEN_FILE=/root/otel.token \
  REPO_URL=https://repo.corp.example/otel/el9/ \
  HOST_ATTRIBUTES="deployment.environment.name=prod,datacenter=sh1,team=infra,business_line=payments,role=db" \
  PROCESS_NAMES="sshd nginx" \
  bash centos-install.sh

# OTLP/gRPC, no auth (lab):
# sudo COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh

# Or use a pre-downloaded RPM (air-gapped / mirrored):
# sudo RPM_PATH=./otelcol-contrib_0.164.0_linux_amd64.rpm COLLECTOR_ENDPOINT=10.0.0.20:4317 bash centos-install.sh
```

The script:

1. Installs the RPM from a local file (`RPM_PATH`), the internal repo (`REPO_URL`) or the GitHub release, in that order of precedence
2. Writes `/etc/otelcol-contrib/config.yaml` (host metrics + per-process metrics + journald / file logs)
3. Writes `/etc/otelcol-contrib/otelcol-contrib.conf` (`COLLECTOR_ENDPOINT`, `KEEP_PROCESS_PIDS`, optional `OTEL_TOKEN`)
4. Runs `otelcol-contrib validate` on the new config. If it fails, the previous config is restored, the running agent is left alone and the script exits 1
5. OTLP/HTTP only: **preflight** — POSTs an empty OTLP request to `<endpoint>/v1/metrics` with the same credentials and the same CA store (no proxy, like the systemd service). Anything but 2xx (401 = wrong token, certificate error = company CA missing) restores the previous config and exits 1
6. Writes the one managed systemd drop-in `10-otelcol-agent.conf` (no capabilities + sandbox, see below) and removes drop-ins left by older versions
7. **Restarts** `otelcol-contrib` and waits 8 s; if the service is not `active` or has auto-restarted, it prints the last journal lines and exits 1

Other variables: `SERVICE_NAME` (default `centos-host`, letters/digits/`._-` only) becomes `service.name`, so logs land under that `service_name` in Loki and metrics get it as `job` in Prometheus. `SYSTEM_LOGS`, `LOG_CAPS`, `ENABLE_PROCESS_METRICS` and `KEEP_PROCESS_PIDS` accept only `true` / `false`; the removed `ENABLE_LOGS` / `PROCESS_CAPS` are rejected so an old command line cannot silently do something else. `OTEL_TOKEN_FILE` reads the token from a file instead of the command line. Only the 5 newest `config.yaml.bak.*` / `otelcol-contrib.conf.bak.*` are kept (the conf backups contain `OTEL_TOKEN`).

### Package source

Packages are built and published by internal teams, so the installer does no separate digest check; it relies on the source:

| Variable | Default | Meaning |
|----------|---------|---------|
| `RPM_PATH` | unset | Install this local RPM file |
| `REPO_URL` | unset | Internal yum repo base URL (the directory holding `repodata/`). Used for this run only: `dnf install --repofrompath ... otelcol-contrib-<OTEL_VERSION>`, metadata cached in the work dir, **no `.repo` file is written**. `gpgcheck` is off for this repo; use an `https://` URL |
| neither | — | Download the GitHub release RPM over HTTPS |
| `WORKDIR` | fresh `mktemp -d` | Work directory for downloads and dnf metadata, removed on exit unless set explicitly. Never a predictable path, so another local user cannot pre-place an RPM that root then installs |

### Logs (both optional)

| Source | Variable | Default | How it is read |
|---|---|---|---|
| System logs | `SYSTEM_LOGS` | `true` | `journald` receiver, priority `info` and above (includes `authpriv`, i.e. what rsyslog writes to `/var/log/secure`) |
| Application log files | `LOG_PATHS` | none | `file_log` on the given absolute paths / globs |

```bash
# system logs + application files
sudo COLLECTOR_ENDPOINT=... LOG_PATHS="/var/log/myapp/*.log /opt/app/logs/*.log" bash centos-install.sh
# metrics only
sudo COLLECTOR_ENDPOINT=... SYSTEM_LOGS=false bash centos-install.sh
```

System logs come from journald, the source rsyslog copies from, instead of `/var/log/messages`: no file permissions to bypass (the service only gets `SupplementaryGroups=systemd-journal`), works on hosts without rsyslog, and each record carries its priority and origin. The agent keeps `MESSAGE` as the body, maps `PRIORITY` to severity (`fatal`/`error`/`warn`/`info`) and keeps `systemd.unit` and `syslog.identifier`; the other journal fields are dropped. In Loki these land as `detected_level` and structured metadata (`systemd_unit`, `syslog_identifier`), not as index labels.

Application log files must be readable by the `otelcol-contrib` user: that is the application owner's job (group ownership or an ACL). The installer warns about matching files it cannot read. `LOG_CAPS=true` grants `CAP_DAC_READ_SEARCH` as a stopgap, but then the agent can read **any** file (`/etc/shadow`, private keys); use it only during a migration. Paths under `/home`, `/root` and `/run/user` are rejected because the sandbox hides them. Globs are written unexpanded, so files created later are picked up; rotated files are excluded with `**/*.gz` and `**/*.[0-9]`.

Both receivers persist their read position (journald cursor, file offsets) with the `file_storage` extension in `STORAGE_DIR` (default `/var/lib/otelcol-contrib/file_storage`): lines written while the agent is stopped are collected once it is back.

Notes:

- **Volatile journal**: if `/var/log/journal` does not exist, journald keeps logs only in `/run/log/journal` and loses them at reboot, including lines the agent had not shipped yet. Make the journal persistent in your host baseline (`mkdir -p /var/log/journal`, or `Storage=persistent`); the installer does not change journald settings.
- The agent's own log goes to journald too, so it is shipped as `systemd_unit=otelcol-contrib.service`. During a gateway outage this adds retry lines.
- Gateway outage: the OTLP exporter retries with backoff for up to 5 minutes per batch (in-memory queue); batches older than that are dropped. Shorter outages are replayed with original timestamps.

### Per-process metrics (`process` scraper)

CPU and memory of individual processes, via the `host_metrics` `process` scraper (separate from the aggregate `processes` scraper). Each process is a separate resource with `process.executable.name`, `process.executable.path`, `process.command_line`, `process.owner`, ...

Enabled metrics: `process.cpu.time`, `process.cpu.utilization` (opt-in in 0.164.0, enabled explicitly; first appears on the 2nd scrape), `process.memory.usage`, `process.memory.virtual`. `process.disk.io` is switched off: reading other users' `/proc/<pid>/io` needs `CAP_SYS_PTRACE`, which would let the agent read the memory of any process.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PROCESS_NAMES` | unset | Process names to collect, **space- or comma-separated** (`"rsyslogd, sshd,otelcol-contrib"`) -> `include.names`. Unset (or empty) = **all processes** |
| `PROCESS_MATCH_TYPE` | `strict` | `strict` = exact match on the process name; `regexp` = Go regexp, **unanchored** (`ssh` also matches `sshd`; use `^sshd$`) |
| `ENABLE_PROCESS_METRICS` | `true` | `false` removes the `process` scraper entirely |

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

### Privileges and sandbox

The service runs as the RPM's non-root user `otelcol-contrib` with **no capabilities** and inside a systemd sandbox. The installer manages exactly one drop-in, `/etc/systemd/system/otelcol-contrib.service.d/10-otelcol-agent.conf`:

```ini
[Service]
CapabilityBoundingSet=                 # LOG_CAPS=true: CAP_DAC_READ_SEARCH
AmbientCapabilities=
SupplementaryGroups=systemd-journal    # only with SYSTEM_LOGS=true
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=-/var/lib/otelcol-contrib/file_storage
ProtectHome=yes
PrivateTmp=yes
InaccessiblePaths=-/etc/ssh -/etc/sudoers -/etc/sudoers.d -/etc/pki/tls/private
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
```

Why no capabilities (verified on a CentOS Stream 9 VM, SELinux `Enforcing`):

| Capability | Would give | Granted? |
|---|---|---|
| `CAP_SYS_PTRACE` | per-process disk I/O of other users' processes, **and** reading any process's environment and memory (read 64 bytes of `sshd` memory in the test) | never |
| `CAP_DAC_READ_SEARCH` | reading 0600 log files, **and** any file: `/etc/shadow`, SSH host keys | only with `LOG_CAPS=true` |

With the drop-in the running agent has `CapEff=0`, `NoNewPrivs=1`, and cannot read `/etc/shadow`, SSH host keys, `/root`, or `/proc/<pid>/{environ,mem}` of `sshd`; `systemd-analyze security` goes from 7.2 MEDIUM to 4.2 OK. `/etc/shadow` cannot be listed in `InaccessiblePaths`: SELinux denies systemd mounting over `shadow_t` files and the service fails to start; without capabilities its `0000` mode already protects it. Older versions added the agent to the `adm` group and wrote `10-process-metrics.conf` / `10-read-logs.conf`; the installer removes all three.

Non-root also means other users' `/proc/<pid>/exe` and `io` are unreadable, so the generated config sets `mute_process_{name,exe,io,user,cgroup}_error: true` to avoid an error line per PID per interval.

SELinux: the RPM ships no policy, so the service runs as `unconfined_service_t`; logs, metrics and the sandbox worked with 0 AVC denials. If your hosts confine it with a custom policy, check `ausearch --input-logs -m avc -ts recent` after enabling.

#### Same-name processes are summed, PIDs are stripped (default)

`process.pid` and `process.parent_pid` change on every process restart, so exporting them creates a new time series each time and blows up cardinality in the backend.
But simply deleting them makes several processes with the same name and owner (nginx / php-fpm / httpd workers, two `sleep`s...) carry identical attributes, and the backend keeps only one of them: the value is silently wrong.

So by default the metrics pipeline:

1. `transform/process_identity` copies `process.executable.name` and `process.owner` onto every `process.*` data point, aligns their timestamps, and deletes all `process.*` resource attributes (pid, parent_pid, command, command_line, executable.path)
2. `groupbyattrs/processes` regroups the points by name + owner
3. `metrics_transform/sum_processes` sums them: memory with no labels, CPU per `state`, disk I/O per `direction`

Result: one series per executable name + owner, holding the total of all matching processes (verified: three `sleep` processes of 1820 KiB RSS each -> one series of 5460 KiB).
`process.cpu.time` is a sum of cumulative counters, so when one of the processes exits the total drops and `rate()` sees a counter reset.

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

**Pass the token as a file.** `sudo` logs its full command line to the journal (`authpriv`), and with `SYSTEM_LOGS=true` those lines are shipped to Loki: `sudo OTEL_TOKEN=... bash centos-install.sh` would put the token into the central log store (observed in the test VM). Use `OTEL_TOKEN_FILE=/root/otel.token` (mode `0600`, written by config management); the token is then also absent from `ps` and shell history.

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

Component names for 0.164.0+: `host_metrics`, `journald`, `file_log`, `resource_detection`, `otlp_grpc` / `otlp_http` (old aliases such as `filelog` still work but warn).

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
          process.disk.io: {enabled: false}   # needs CAP_SYS_PTRACE
  journald: {priority: info, start_at: end, storage: file_storage}
  file_log:
    include:
      - /var/log/myapp/*.log
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
      receivers: [journald, file_log]
      processors: [memory_limiter, transform/journald, resource/service, resource_detection, transform/instance_id, batch]
      exporters: [otlp_grpc]
```

See also `agent-config.yaml` and the config generated by `centos-install.sh`.

## Gateway (minimal)

`gateway-config.yaml` receives OTLP **metrics and logs** (both pipelines are required; without a `logs` pipeline the agent gets `Unimplemented ... LogsService` and drops every log batch) and prints with the `debug` exporter. In production, replace `debug` with Prometheus remote_write / OTLP / Kafka / etc.

It listens on `0.0.0.0:4317` (gRPC) and `0.0.0.0:4318` (HTTP) and writes to `./logs/gateway-{metrics,logs}.json` relative to the working directory (run it from this folder). It is a **verification gateway with no authentication**: do not expose it to the public internet.

Allow **4317/tcp** (gRPC) or **4318/tcp** (HTTP) from agents to the gateway.

## Verification status

Current behaviour, verified on a CentOS Stream 9 VM (Lima, kernel 5.14, SELinux `Enforcing`) with otelcol-contrib 0.164.0:

| Area | Check | Result |
|---|---|---|
| Install | Upgrade over the previous version (two capability drop-ins, agent in `adm`) | Pass: replaced by `10-otelcol-agent.conf`, removed from `adm`, service `active` |
| Install | Package from internal repo (`REPO_URL=file://` / `https://`), `RPM_PATH`, GitHub | Pass; no `.repo` file or dnf cache left; `http://` repo rejected |
| Install | Invalid generated config / collector cannot start (port taken) | Pass: exit 1; config restored and running agent untouched / journal tail printed |
| Install | Removed `ENABLE_LOGS` / `PROCESS_CAPS`, `LOG_PATHS` under `/home` or relative, newline in `COLLECTOR_ENDPOINT`, `OTEL_TOKEN` + `OTEL_TOKEN_FILE` | Pass: exit 1 before anything is changed |
| Privileges | Running agent | `CapEff=0`, `NoNewPrivs=1`, groups `otelcol-contrib systemd-journal`; `systemd-analyze security` 4.2 OK |
| Privileges | Agent reading `/etc/shadow`, SSH host key, `/root`, `/proc/<sshd>/environ`, `/proc/<sshd>/mem` | Pass: all denied (root outside the sandbox can read them) |
| Privileges | `LOG_CAPS=true` | `CapEff` = `CAP_DAC_READ_SEARCH` only; installer prints the warning |
| Transport | OTLP/HTTP `https://` + `Basic` token, company CA only in the system trust store | Pass: preflight HTTP 200, data arrives |
| Transport | Preflight with wrong password / no token / CA missing | Pass: 401 / 401 / certificate error, exit 1, previous config kept |
| Transport | `OTEL_TOKEN_FILE` | Pass: preflight 200 |
| Transport | mTLS to gateway; gRPC to Prometheus | Pass; `instance=<host.name>`, `job=centos-host` |
| Identity | `HOST_ATTRIBUTES`, `host.id`, `host.arch`, `os.description`, `service.instance.id` | Pass: all on metrics and logs |
| Logs | journald: `authpriv` (sshd login), `err`, `warning` | Pass: severity `info` / `error` / `warn`, `systemd_unit`, `syslog_identifier`; body is the message only |
| Logs | Lines written while the agent is stopped (journald and file) | Pass: collected after start |
| Logs | 0600 application log without `LOG_CAPS` | Installer warns; file not read |
| Logs | `SYSTEM_LOGS=false`, no `LOG_PATHS` | Pass: no log receivers, no journal group |
| Metrics | Same-name processes (3x `sleep`) | Pass: one series = sum (5460 KiB = 3 x 1820); `KEEP_PROCESS_PIDS=true` gives one series per pid |
| Metrics | `process.disk.io` | Not exported (0 series) |
| Metrics | `process.command_line` / `command` | Never exported, `KEEP_PROCESS_PIDS=true` included |
| Metrics | Excludes: dummy `veth`, bridge, tmpfs, container mount, loop device | Pass: only real interfaces, filesystems, disks; xfs on `/dev/loop0` still reported |
| Resilience | Collector down 90 s | Pass: metrics and logs replayed, no gap |
| Resilience | VM reboot | Pass: agent back, offsets kept |

Raw samples and permission experiments: [`evidence/process-metrics-centos9.md`](evidence/process-metrics-centos9.md).

Sample metric names observed: `system.cpu.utilization`, `system.memory.usage`, `system.disk.io`, `system.filesystem.usage`, `system.network.io`, `system.cpu.load_average.*`, `system.paging.*`, `system.processes.*`, `process.cpu.time`, `process.cpu.utilization`, `process.memory.usage`, `process.memory.virtual`.

## Files in this folder

| Path | Description |
|------|-------------|
| `centos-install.sh` | one-shot CentOS/RHEL installer |
| `agent-config.yaml` | production-oriented agent config |
| `agent-config.lab.yaml` | local lab agent (127.0.0.1) |
| `gateway-config.yaml` | minimal gateway |
| `run-lab.sh` | local smoke test helper (needs `./bin/otelcol-contrib`, not in the repo) |
| `evidence/` | live verification output (per-process metrics on CentOS Stream 9) |
