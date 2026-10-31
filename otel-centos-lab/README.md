# CentOS / RHEL OpenTelemetry host agent

Install **otelcol-contrib** on CentOS Stream / RHEL / Rocky / Alma hosts to ship **host metrics**, **system logs (journald)** and optional **application log files** over **OTLP/HTTP** to a central OpenTelemetry Collector (Mimir for metrics, Loki for logs). The agent runs **without capabilities** in a systemd sandbox.

Verified with **otelcol-contrib 0.164.0** (linux amd64) on CentOS Stream 9 with SELinux `Enforcing`.

```
host: otelcol-contrib (user otelcol-contrib, no capabilities, systemd sandbox)
  host_metrics (+ per-process for PROCESS_NAMES)  journald (SYSTEM_LOGS)  file_log (LOG_PATHS)
        │  cardinality guards, process sums, host identity / attributes
        ▼
  otlp_http ──HTTPS + Basic token──► central collector (tenant from the basic-auth account) ──► Mimir / Loki
```

## Install

```bash
read -rs OTEL_TOKEN && export OTEL_TOKEN      # base64("user:password"); not echoed, not in shell history
sudo -E COLLECTOR_ENDPOINT=https://otel-gw.corp.example:4318 \
  REPO_URL=https://repo.corp.example/otel/el9/ \
  HOST_ATTRIBUTES="deployment.environment.name=prod,datacenter=sh1,team=infra,business_line=payments,role=db" \
  PROCESS_NAMES="sshd nginx" \
  LOG_PATHS="/var/log/nginx/*.log" \
  bash centos-install.sh
```

Run it from this folder: the script installs the config fragments in `agent/`.

**Never put the token on the sudo command line.** `sudo` logs its command line to the journal, and the variables passed with `--preserve-env=...` as well (`ENV=OTEL_TOKEN=...`); with `SYSTEM_LOGS=true` those lines are shipped to Loki. With `sudo -E` the environment is not logged (verified). `sudo -E` needs `SETENV` in sudoers; alternatively run the script from a root shell.

| Variable | Default | Meaning |
|---|---|---|
| `COLLECTOR_ENDPOINT` | required | `https://host:port` of the central collector (`http://` only without a token, e.g. a lab) |
| `OTEL_TOKEN` | none | Basic auth token `base64("user:password")`; sent as `Authorization: Basic …`, requires `https://` |
| `REPO_URL` | GitHub release | Internal yum repo (`https://` or `file://`), used for this run only |
| `OTEL_VERSION` | `0.164.0` | Package version |
| `HOST_ATTRIBUTES` | none | `key=value,…` resource attributes for this host (see [Host identity](#host-identity-and-attributes-mimir)) |
| `SERVICE_NAME` | `centos-host` | `service.name` → `job` in Mimir, `service_name` in Loki |
| `PROCESS_NAMES` | none | Exact process names (space/comma-separated) for per-process CPU/memory; none = no per-process metrics |
| `KEEP_PROCESS_PIDS` | `false` | `true` = one series per pid instead of per name+owner (debugging only) |
| `SYSTEM_LOGS` | `true` | System logs from journald, priority `info` and above |
| `LOG_PATHS` | none | Application log files (absolute paths / globs); none = no file logs |

What the script does:

1. Checks the inputs (values go into a systemd EnvironmentFile: no whitespace, quotes or control characters).
2. Installs the RPM from `REPO_URL` (`dnf --repofrompath`, no `.repo` file left; the RPM is unsigned, so `gpgcheck` is off for it and the URL must be `https://`/`file://`) or downloads the GitHub release over https into a private `mktemp -d` directory.
3. Stages the selected fragments and the EnvironmentFile in that private directory, runs `otelcol-contrib validate` as the agent user, and **preflights** the collector: an empty OTLP export with the same token and the system CA store. Any failure (401 = wrong token, certificate error = company CA missing from the system trust store) exits 1 **before the running agent is touched**.
4. Installs the fragments into `/etc/otelcol-contrib/`, writes `otelcol-contrib.conf` (`0640 root:otelcol-contrib`, holds the token) and the sandbox drop-in, removes leftovers that may hold an old token (`*.bak.*`, `*.rpmsave`).
5. Restarts the service and fails unless it is still `active` with no auto-restart 8 s later.

## Configuration = static fragments + environment

| Fragment | Loaded when | Contents |
|---|---|---|
| `agent/agent.yaml` | always | host metrics with cardinality guards, host identity, `otlp_http` exporter |
| `agent/auth.yaml` | `OTEL_TOKEN` set | `Authorization: Basic ${env:OTEL_TOKEN}` |
| `agent/processes.yaml` | `PROCESS_NAMES` set | per-process CPU/memory, same-name processes summed |
| `agent/logs-journald.yaml` | `SYSTEM_LOGS=true` | journald receiver + severity mapping |
| `agent/logs-files.yaml` | `LOG_PATHS` set | `file_log` receiver |

The service loads them with `OTELCOL_OPTIONS="--config=… --config=…"` (maps are merged, lists replaced). Per-host values live in `/etc/otelcol-contrib/otelcol-contrib.conf` and are referenced as `${env:…}`; lists are written as JSON arrays (`PROCESS_NAMES='["sshd","nginx"]'`), which the collector parses as YAML lists. The fragments contain no host-specific values, so they can be reviewed and diffed as plain files.

## Logs

- **System logs** come from journald, the source rsyslog copies `/var/log/messages` and `secure` from: no file permissions to bypass (the service only gets `SupplementaryGroups=systemd-journal`), works on hosts without rsyslog, and every record carries its priority. The agent keeps `MESSAGE` as the body, maps `PRIORITY` to severity (`fatal`/`error`/`warn`/`info`), keeps `systemd.unit` and `syslog.identifier` and drops the other journal fields. In Loki they appear as `detected_level` and structured metadata (`systemd_unit`, `syslog_identifier`), not as index labels.
- **Application log files** must be readable by user `otelcol-contrib` (group or ACL, set by the application owner); the installer warns about matching files it cannot read. Paths under `/home`, `/root`, `/run/user` are rejected (hidden by the sandbox). Globs are matched at runtime; rotated files (`*.gz`, `*.[0-9]`) are excluded.
- Both receivers persist their read position (journald cursor, file offsets) in `/var/lib/otelcol-contrib/file_storage`, so lines written while the agent is stopped are collected afterwards.
- **Volatile journal**: without `/var/log/journal` the journal lives in `/run/log/journal` and is lost at reboot, including lines not shipped yet. Make it persistent in the host baseline; the installer does not change journald settings.
- Collector outage: the exporter retries for up to 5 minutes per batch (in-memory queue); a 90 s outage was replayed without gaps.

## Per-process metrics

`PROCESS_NAMES` selects processes by exact name (Linux `comm`, max 15 characters). Exported: `process.cpu.time`, `process.cpu.utilization`, `process.memory.usage`, `process.memory.virtual`. `process.disk.io` is off: reading other users' `/proc/<pid>/io` needs `CAP_SYS_PTRACE`, which would let the agent read any process's memory.

`process.pid` changes on every restart and would blow up cardinality, but dropping it makes several processes with the same name and owner (nginx / php-fpm workers) overwrite each other. So the agent copies name and owner onto the data points, regroups by them and **sums** them: one series per executable name + owner (verified: three `sleep` processes → one series with their total RSS). Name and owner end up as data point labels (`process_executable_name`, `process_owner`), not resource attributes: Mimir/Prometheus would otherwise keep them only in `target_info`, and every process of a host would land in the same series unless the backend promotes them. Summed CPU time drops when one process exits, which `rate()` treats as a counter reset. `process.command_line` / `command` can carry secrets (`mysql -pSECRET`) and are never exported, `KEEP_PROCESS_PIDS=true` included.

## Cardinality guards

| Source | Excluded | Why |
|---|---|---|
| `network` | `lo`, `veth*`, `docker*`, `br-*`, `cni*`, `cali*`, `flannel*`, `cilium*`, `lxc*`, `virbr*`, `vnet*` | per-container / per-VM interfaces get new names on every restart |
| `filesystem` | pseudo/virtual types (`tmpfs`, `overlay`, `squashfs`, `iso9660`, `proc`, `sysfs`, `cgroup2`, …), mount points under `/dev`, `/proc`, `/sys`, `/run`, `/var/lib/{docker,containers,kubelet}/` | one series set per container / mount |
| `disk` | `loop*`, `ram*`, `zram*`, `sr*`, `fd*` | snap/image loop devices, removable media |
| `process.*` | `pid`, `parent_pid`, `executable.path`, `command`, `command_line` | churn and secrets |

Real filesystems on loop or LVM devices are still reported. The central collector should enforce the same drop policy (and per-tenant series limits) as a safety net for misconfigured or older agents.

## Privileges and sandbox

The service runs as `otelcol-contrib` with **no capabilities**. The installer writes one drop-in, `/etc/systemd/system/otelcol-contrib.service.d/10-otelcol-agent.conf`: empty `CapabilityBoundingSet`, `SupplementaryGroups=systemd-journal` (only with `SYSTEM_LOGS=true`), `NoNewPrivileges`, `ProtectSystem=strict` with `ReadWritePaths=/var/lib/otelcol-contrib/file_storage`, `ProtectHome`, `PrivateTmp`, `RestrictNamespaces`, `LockPersonality`, `SystemCallArchitectures=native`.

Without capabilities, plain file permissions already keep the agent user away from secrets: verified on CentOS Stream 9, it cannot read `/etc/shadow`, SSH host keys, sudoers, `/root` or `/proc/<pid>/{environ,mem}` of other processes, even outside the sandbox. The sandbox therefore only adds what file permissions do not cover: no privilege escalation through setuid binaries (`NoNewPrivileges`), no user namespaces (a common kernel-exploit entry point), no writes outside the storage directory, and hidden home directories (some hosts have world-readable ones). Running agent: `CapEff=0`, `NoNewPrivs=1`; `systemd-analyze security` 4.9 OK (7.2 MEDIUM without the drop-in). Why no capabilities:

| Capability | Would give | |
|---|---|---|
| `CAP_SYS_PTRACE` | other users' per-process disk I/O, **and** any process's environment and memory (read `sshd` memory in the test) | not granted |
| `CAP_DAC_READ_SEARCH` | 0600 log files, **and** any file (`/etc/shadow`, SSH host keys) | not granted |

The RPM ships no SELinux policy, so the service runs as `unconfined_service_t`; everything above worked with 0 AVC denials.

The systemd service does not inherit the login shell's proxy variables. If your hosts set a proxy for all services (`DefaultEnvironment`), put the central collector in `NO_PROXY`.

## Host identity and attributes (Mimir)

Mimir builds the series identity of OTLP data from `service.name` → `job` and `service.instance.id` → `instance`; other resource attributes only go to `target_info` unless promoted. All hosts share `service.name`, so the agent sets **`service.instance.id = host.name`** (otherwise hosts would overwrite each other's series). It also detects `host.id` (machine-id), `host.arch`, `os.description` and adds `HOST_ATTRIBUTES` (keys `[A-Za-z0-9._-]`, values `[A-Za-z0-9._/:-]`; they win over detected values).

Attributes that are constant per host do not add series. Promote only what nearly every query or alert route uses:

| Attribute | Source | Promote in Mimir |
|---|---|---|
| `service.instance.id` | agent (= `host.name`) | automatic (`instance`) |
| `host.name` | detected | yes |
| `deployment.environment.name`, `datacenter`, `team` | `HOST_ATTRIBUTES` | yes |
| `business_line`, `role` | `HOST_ATTRIBUTES` | no: `target_info` only (a role change then re-creates one series, not all of them) |
| `host.id`, `host.arch`, `os.description` | detected | no: change with clones / patches |

```yaml
# Mimir runtime config, per tenant
overrides:
  <tenant>:
    promote_otel_resource_attributes: "host.name,deployment.environment.name,datacenter,team"
```

```promql
system_memory_utilization_ratio{state="used"}
  * on (job, instance) group_left (role, business_line) target_info{role="db"}
```

Cloned VMs keep the template's `/etc/machine-id` unless the image pipeline resets it, so `host.id` is only unique if it does.

## Grafana dashboard

`grafana/centos-host.json`: overview, CPU, memory, load, filesystems, disk and network I/O, per-process CPU/memory, log volume by level and the log stream. Import it in Grafana and pick the **Metrics** (Mimir, Prometheus type) and **Logs** (Loki) data sources in the variables at the top; the data source UIDs are not hard-coded.

- Hosts are selected by `job` (`SERVICE_NAME`) and `instance` (`service.instance.id` = host name), which every series has, so the dashboard needs **no** resource-attribute promotion in Mimir.
- Metric names follow Mimir's default OTLP translation without unit/type suffixes (`system_cpu_time`, `system_memory_utilization`, `process_memory_usage`). If your Mimir sets `otel_metric_suffixes_enabled: true` (or you use Prometheus' OTLP receiver), names get suffixes (`system_cpu_time_seconds_total`) and the queries need them too.
- Logs are filtered by `service_instance_id`, `detected_level` and `systemd_unit` (structured metadata), not by index labels.

## Verification

CentOS Stream 9 VM (Lima, kernel 5.14, SELinux `Enforcing`), otelcol-contrib 0.164.0; test collector with OTLP/HTTP + TLS (test CA in the system trust store) + basic auth; local collector → single-instance Mimir 2.16 + Loki 3.5, Grafana 11.4.

| Area | Check | Result |
|---|---|---|
| Install | Over an older install; from internal repo (`file://`) and from GitHub | Pass; only the managed fragments, conf and drop-in remain |
| Install | `https://` + Basic token via `sudo -E` | Pass: preflight 200, data arrives; token appears 0 times in the journal |
| Install | Wrong password | Exit 1 at preflight (401), running agent and config unchanged |
| Install | Invalid inputs: `host:port` endpoint, token over `http://`, process name > 15 chars, `LOG_PATHS` under `/home`, `http://` repo, malformed `HOST_ATTRIBUTES`, non-boolean flag | Exit 1 before anything is changed |
| Privileges | Running agent | `CapEff=0`, `NoNewPrivs=1`; groups `otelcol-contrib` (+ `systemd-journal` with system logs); `systemd-analyze security` 4.9 OK |
| Privileges | Reading `/etc/shadow`, SSH host key, `/root`, `/proc/<sshd>/environ`, `/proc/<sshd>/mem` | Denied (root outside the sandbox can read them) |
| Logs | journald `err` / `warning` / `authpriv` lines | `error` / `warn` / `info` with `syslog_identifier`, `systemd_unit` |
| Logs | Lines written while the agent was stopped (journald and file) | Collected after start |
| Logs | 0600 application log | Installer warns, file not read |
| Metrics | Three `sleep` processes, same owner | One series = sum of their RSS |
| Metrics | `KEEP_PROCESS_PIDS=true` | One series per pid |
| Metrics | `process.disk.io`, `process.command_line` | Not exported |
| Metrics | Dummy `veth`, bridge, tmpfs, container mount, loop device | Excluded; xfs on `/dev/loop0` still reported |
| Identity | `HOST_ATTRIBUTES`, `host.id`, `host.arch`, `os.description` | On metrics and logs; `instance=<host.name>`, `job=centos-host` |
| Mimir | Single-instance Mimir 2.16 (multi-tenant, tenant header set by the collector) | Metrics arrive under the tenant only; promoted `host_name`, `deployment_environment_name`, `datacenter`, `team`; one `target_info` per host; one series per process name + owner (`sleep` sum = RSS sum) |
| Grafana | Every dashboard query through Grafana's Mimir and Loki data sources | All 16 return data |
| Resilience | Collector down 90 s; VM reboot | Replayed without gaps; agent back with offsets kept |

## Files

| Path | Description |
|---|---|
| `centos-install.sh` | installer |
| `agent/*.yaml` | agent config fragments |
| `grafana/centos-host.json` | Grafana dashboard (Mimir + Loki) |
