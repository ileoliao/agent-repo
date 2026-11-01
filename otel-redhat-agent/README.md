# Red Hat (RHEL) OpenTelemetry host agent

Install **otelcol-contrib** on Red Hat Enterprise Linux and RHEL-compatible hosts to ship **host metrics**, **system logs (journald)** and optional **application log files** over **OTLP/HTTP** to a central OpenTelemetry Collector (Mimir for metrics, Loki for logs). The agent runs **without capabilities** in a systemd sandbox.

Verified with **otelcol-contrib 0.164.0** (linux amd64) on a RHEL 9-family VM with SELinux `Enforcing`.

```
host: otelcol-contrib (user otelcol-contrib, no capabilities, systemd sandbox)
  host_metrics (+ per-process for PROCESS_NAMES)  journald (SYSTEM_LOGS)  file_log (LOG_PATHS)
        │  cardinality guards, process sums, host identity / attributes
        ▼
  otlp_http ──HTTPS + Basic token──► central collector (tenant from the basic-auth account) ──► Mimir / Loki
```

## Install

Settings live in **profiles**: plain `KEY=VALUE` files kept in this repo (`profiles/`), typically one per environment, machine role and region, e.g. `profiles/prod-db-hk.env`. Name them as you like (a prefix such as `payments-prod-db-hk.env` is fine); `profiles/example.env` is the template. A profile holds everything except the token:

```bash
COLLECTOR_ENDPOINT=https://otel-gw.hk.corp.example:4318
REPO_URL=https://repo.corp.example/otel/el9/
HOST_ATTRIBUTES=deployment.environment.name=prod,team=infra,business_line=payments,role=db,region=hk
PROCESS_NAMES=sshd mysqld
LOG_PATHS=/var/log/mysql/*.log
```

```bash
# first install: with the token
read -rs OTEL_TOKEN && export OTEL_TOKEN      # base64("user:password"); not echoed, not in shell history
sudo -E bash otel-redhat-agent/redhat-install.sh otel-redhat-agent/profiles/prod-db-hk.env

# change settings: edit the profile in the repo, then re-run; the installed token is kept
sudo bash otel-redhat-agent/redhat-install.sh otel-redhat-agent/profiles/prod-db-hk.env

# one host differs: a variable on the command line overrides the profile
sudo SYSTEM_LOGS=false bash otel-redhat-agent/redhat-install.sh otel-redhat-agent/profiles/prod-db-hk.env
```

- A profile may only contain the variables below except `OTEL_TOKEN`; a token, an unknown key or a malformed line is refused. Profiles are parsed, never executed.
- A re-run without `OTEL_TOKEN` keeps the installed token; pass a new one to rotate it (the preflight checks it either way). Without a profile, all variables come from the command line.
- A re-run with the installed `OTEL_VERSION` skips the package step. `otelcol-contrib.conf` records which profile the host was installed with.

**Never put the token on the sudo command line.** `sudo` logs its command line to the journal, and the variables passed with `--preserve-env=...` as well (`ENV=OTEL_TOKEN=...`); with `SYSTEM_LOGS=true` those lines are shipped to Loki. With `sudo -E` the environment is not logged (verified). `sudo -E` needs `SETENV` in sudoers; alternatively run the script from a root shell.

| Variable | Default | Meaning |
|---|---|---|
| `COLLECTOR_ENDPOINT` | required | `https://host:port` of the central collector; https only, verified against the system trust store |
| `OTEL_TOKEN` | installed one | Basic auth token `base64("user:password")`, sent as `Authorization: Basic …`; environment only, never in a profile |
| `REPO_URL` | GitHub release | Internal yum repo (`https://` or `file://`), used for this run only |
| `OTEL_VERSION` | `0.164.0` | Package version |
| `HOST_ATTRIBUTES` | none | `key=value,…` resource attributes for this host (see [Host identity](#host-identity-and-attributes-mimir)) |
| `SERVICE_NAME` | `redhat-host` | `service.name` → `job` in Mimir, `service_name` in Loki |
| `PROCESS_NAMES` | none | Exact process names (space/comma-separated) for per-process CPU/memory; none = no per-process metrics |
| `KEEP_PROCESS_PIDS` | `false` | `true` = one series per pid instead of per name+owner (debugging only) |
| `SYSTEM_LOGS` | `true` | System logs from journald, priority `info` and above |
| `LOG_PATHS` | none | Application log files (absolute paths / globs); none = no file logs |
| `AGENT_CPU_QUOTA` | `50%` | CPU ceiling (`100%` = one core); see [Resource ceiling](#resource-ceiling) |
| `AGENT_MEMORY_MAX` | `300M` | Memory ceiling (`M`/`G`, at least `128M`); the other memory limits are derived from it |

What the script does:

1. Checks the inputs (values go into a systemd EnvironmentFile: no whitespace, quotes or control characters).
2. Installs the RPM (skipped when `OTEL_VERSION` is already installed) from `REPO_URL` (`dnf --repofrompath`, no `.repo` file left; the RPM is unsigned, so `gpgcheck` is off for it and the URL must be `https://`/`file://`) or downloads the GitHub release over https into a private `mktemp -d` directory.
3. Stages the selected fragments and the EnvironmentFile in that private directory, runs `otelcol-contrib validate` as the agent user, and **preflights** the collector: an empty OTLP export with the same token and the system CA store. Any failure (401 = wrong token, certificate error = company CA missing from the system trust store) exits 1 **before the running agent is touched** (except on a version change: the RPM's own scriptlet already restarted it in step 2, see [Upgrade and rollback](#upgrade-and-rollback)).
4. Installs the fragments into `/etc/otelcol-contrib/`, writes `otelcol-contrib.conf` (`0640 root:otelcol-contrib`, holds the token) and the sandbox drop-in, removes leftovers that may hold an old token (`*.bak.*`, `*.rpmsave`).
5. Restarts the service and fails unless it is still `active` with no auto-restart 8 s later.

## Upgrade and rollback

1. Put the new `otelcol-contrib` RPM into the internal repo (without `REPO_URL` the version must exist as a GitHub release).
2. Change `OTEL_VERSION` in the profile, or override it for a test run: `sudo -E OTEL_VERSION=<new> bash redhat-install.sh <profile>`.
3. **Re-run on one dev host first** and check its dashboards: the RPM restarts the agent on the new version with the current config before the script validates it, so an incompatible version breaks that host (the script exits 1).
4. Then re-run on the remaining hosts. **Rollback** = set the previous `OTEL_VERSION` and re-run (dnf downgrades; tested 0.164.0 → 0.163.2 → 0.164.0).

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
- **Collector outage or back-pressure**: the exporter queues in memory and retries; when the queue or the `memory_limiter` refuses data, both log receivers stop reading and retry (`retry_on_failure`, no time limit) instead of dropping, so the journal and the log files themselves are the buffer. That buffer lasts until logrotate removes a file (rotated `*.[0-9]`/`*.gz` names are not read) or, with a volatile journal, until reboot. Tested: collector down for 150 s while 182,900 file lines and 2,000 journald lines were written: all of them arrived in Loki, nothing refused or dropped by the agent, memory ≤ 154 MiB anonymous, CPU ≤ 23% of a core while catching up.
- The **central collector** must cope with that catch-up burst: bound its batches (`send_batch_max_size`), otherwise a flushed backlog can exceed Loki's 4 MiB gRPC message limit and be dropped there (seen in the lab with an unbounded batch).

## Per-process metrics

`PROCESS_NAMES` selects processes by exact name (Linux `comm`, max 15 characters). Exported: `process.cpu.time`, `process.cpu.utilization`, `process.memory.usage`, `process.memory.virtual`. `process.disk.io` is off: reading other users' `/proc/<pid>/io` needs `CAP_SYS_PTRACE`, which would let the agent read any process's memory.

`process.pid` changes on every restart and would blow up cardinality, but dropping it makes several processes with the same name and owner (nginx / php-fpm workers) overwrite each other. So the agent copies name and owner onto the data points, regroups by them and **sums** them: one series per executable name + owner (verified: three `sleep` processes → one series with their total RSS). Name and owner end up as data point labels (`process_executable_name`, `process_owner`), not resource attributes: as resource attributes Mimir would keep them only in `target_info` (or drop them with it), and every process of a host would land in the same series. Summed CPU time drops when one process exits, which `rate()` treats as a counter reset. `process.command_line` / `command` can carry secrets (`mysql -pSECRET`) and are never exported, `KEEP_PROCESS_PIDS=true` included.

## Cardinality guards

| Source | Excluded | Why |
|---|---|---|
| `network` | `lo`, `veth*`, `docker*`, `br-*`, `cni*`, `cali*`, `flannel*`, `cilium*`, `lxc*`, `virbr*`, `vnet*` | per-container / per-VM interfaces get new names on every restart |
| `filesystem` | pseudo/virtual types (`tmpfs`, `overlay`, `squashfs`, `iso9660`, `proc`, `sysfs`, `cgroup2`, …), mount points under `/dev`, `/proc`, `/sys`, `/run`, `/var/lib/{docker,containers,kubelet}/` | one series set per container / mount |
| `disk` | `loop*`, `ram*`, `zram*`, `sr*`, `fd*` | snap/image loop devices, removable media |
| `process.*` | `pid`, `parent_pid`, `executable.path`, `command`, `command_line` | churn and secrets |

Real filesystems on loop or LVM devices are still reported. The central collector should enforce the same drop policy (and per-tenant series limits) as a safety net for misconfigured or older agents.

## Privileges and sandbox

The service runs as `otelcol-contrib` with **no capabilities**. The installer writes one drop-in, `/etc/systemd/system/otelcol-contrib.service.d/10-otelcol-agent.conf`: empty `CapabilityBoundingSet`, `SupplementaryGroups=systemd-journal` (only with `SYSTEM_LOGS=true`), `NoNewPrivileges`, `ProtectSystem=strict` with `ReadWritePaths=/var/lib/otelcol-contrib/file_storage`, `ProtectHome`, `PrivateTmp`, `RestrictNamespaces`, `LockPersonality`, `SystemCallArchitectures=native`, and the [resource ceiling](#resource-ceiling).

Without capabilities, plain file permissions already keep the agent user away from secrets: verified on a RHEL 9-family VM, it cannot read `/etc/shadow`, SSH host keys, sudoers, `/root` or `/proc/<pid>/{environ,mem}` of other processes, even outside the sandbox. The sandbox therefore only adds what file permissions do not cover: no privilege escalation through setuid binaries (`NoNewPrivileges`), no user namespaces (a common kernel-exploit entry point), no writes outside the storage directory, and hidden home directories (some hosts have world-readable ones). Running agent: `CapEff=0`, `NoNewPrivs=1`; `systemd-analyze security` 4.9 OK (7.2 MEDIUM without the drop-in). Why no capabilities:

| Capability | Would give | |
|---|---|---|
| `CAP_SYS_PTRACE` | other users' per-process disk I/O, **and** any process's environment and memory (read `sshd` memory in the test) | not granted |
| `CAP_DAC_READ_SEARCH` | 0600 log files, **and** any file (`/etc/shadow`, SSH host keys) | not granted |

The RPM ships no SELinux policy, so the service runs as `unconfined_service_t`; everything above worked with 0 AVC denials.

The systemd service does not inherit the login shell's proxy variables. If your hosts set a proxy for all services (`DefaultEnvironment`), put the central collector in `NO_PROXY`.

## Resource ceiling

The agent must never compete with the workload. Two profile variables set the ceiling; everything else is derived:

| Setting | Value (defaults) | Effect |
|---|---|---|
| `CPUQuota` | `AGENT_CPU_QUOTA` (50%) | hard CPU limit |
| `Nice` | 10 | yields to the workload under contention |
| `MemoryMax` | `AGENT_MEMORY_MAX` (300M) | hard limit: OOM kill + restart by systemd, never host pressure |
| `MemoryHigh` | 85% of it (255M) | the kernel reclaims the agent's memory first |
| `GOMEMLIMIT` | 60% of it (180MiB) | Go GC target |
| `GOMAXPROCS` | quota in cores, rounded up, at least 2 | otherwise Go sizes threads and GC workers by the host's core count |
| `memory_limiter` | 55% of it (165 MiB, `MEMORY_LIMIT_MIB`), spike 20% of that | refuses new data before the limits above are reached (its `limit_percentage` would use host memory, not the cgroup limit) |

Measured on a 2-core RHEL 9-family VM, full profile: 0.5–1% of a core, ~75 MiB anonymous memory (`ps` shows ~250 MiB RSS, of which ~180 MiB are pages of the 400 MB binary). With a flood of 10,000 log lines/s: 6–10% of a core. With the central collector down during the flood, memory levelled off at ~150 MiB (the `memory_limiter` refused data, which was dropped) and the queue drained within ~10 s after recovery; no restarts. With `MemoryMax` forced to 90M the agent was OOM-killed and restarted every ~5 s while the host stayed idle.

Raise the ceiling in the profile for log-heavy hosts (e.g. `AGENT_MEMORY_MAX=600M`). For a one-off change on a single host, `systemctl edit otelcol-contrib` writes an `override.conf` that wins over the installer's drop-in and survives re-runs; when it changes `MemoryMax`, set `MemoryHigh` and `Environment=GOMEMLIMIT=… MEMORY_LIMIT_MIB=…` to the same ratios.

## Host identity and attributes (Mimir)

Mimir builds the series identity of OTLP data from `service.name` → `job` and `service.instance.id` → `instance`. Every other resource attribute becomes a label only if it is **promoted**; otherwise Mimir keeps it in the `target_info` series alone. All hosts share `service.name`, so the agent sets **`service.instance.id = host.name`** (otherwise hosts would overwrite each other's series). `host.name` is the OS host name (`hostname`), so host names must be unique within a tenant; where they are not, set `host.name=<fqdn>` in `HOST_ATTRIBUTES` (it also becomes `instance`). It also detects `host.id` (machine-id), `host.arch`, `os.description` and adds `HOST_ATTRIBUTES` (keys `[A-Za-z0-9._-]`, values `[A-Za-z0-9._/:-]`; they win over detected values).

**No Mimir configuration is needed.** Our Mimir drops `target_info`, so the agent (`transform/host_labels` in `agent/agent.yaml`) copies a fixed set of host attributes onto every metric data point, where they become ordinary labels:

| Attribute | Label | Source |
|---|---|---|
| `service.instance.id` | `instance` | agent (= `host.name`) |
| `service.name` | `job` | `SERVICE_NAME` |
| `host.name` | `host_name` | detected |
| `deployment.environment.name`, `team`, `business_line`, `role`, `region` | `deployment_environment_name`, `team`, `business_line`, `role`, `region` | `HOST_ATTRIBUTES` (profile) |

These are constant per host, so they add no series; changing one (a host changes role) re-creates that host's series. Any other `HOST_ATTRIBUTES` key, and `host.id`, `host.arch`, `os.description`, stays a resource attribute: present in Loki, not on metrics. To label another key, add it to `transform/host_labels`. A `promote_otel_resource_attributes` setting in Mimir is not needed and does no harm if present (verified: same labels, no conflict).

Cloned VMs keep the template's `/etc/machine-id` unless the image pipeline resets it, so `host.id` is only unique if it does.

## Grafana dashboards

Two dashboards that link to each other like tabs (a dashboard link on the `redhat-host` tag; switching keeps the time range and every filter):

| File | Title | Content |
|---|---|---|
| `grafana/redhat-host-metrics.json` | Red Hat host · Metrics | host info, overview, CPU, memory, load, filesystems, disk and network I/O, per-process CPU/memory |
| `grafana/redhat-host-logs.json` | Red Hat host · Logs | host info, log volume by level, log stream (filters: level, systemd unit, regex search) |

Import both (Dashboards → New → Import). Grafana asks once for the **Mimir** (Prometheus type) and **Loki** data sources and writes their UIDs into the panels; there is no data source selector on the dashboards. For file provisioning, replace `${DS_MIMIR}` / `${DS_LOKI}` with your data source UIDs first.

- Hosts are narrowed down with cascading, multi-select filters: Environment (`deployment.environment.name`) → Team → Business line → Role → Region → Host. They read the labels on `system_cpu_logical_count` (one series per host), which the agent puts on every series; no `target_info`, no Mimir promotion.
- Panels select series by `job` and `instance`, which every series has. `job` is the agent's `service.name` (`SERVICE_NAME`, default `redhat-host`): it marks the data as coming from this host agent and keeps the dashboards from mixing in other sources of the same metric names in the tenant; it is the same on every host. `instance` is the host (`service.instance.id` = host name).
- Metric names follow Mimir's default OTLP translation without unit/type suffixes (`system_cpu_time`, `system_memory_utilization`, `process_memory_usage`). If your Mimir sets `otel_metric_suffixes_enabled: true` (or you use Prometheus' OTLP receiver), names get suffixes (`system_cpu_time_seconds_total`) and the queries need them too.
- Logs are filtered by `service_instance_id`, `detected_level` and `systemd_unit` (structured metadata), not by index labels.

## Verification

RHEL 9-family VM (Lima, kernel 5.14, SELinux `Enforcing`), otelcol-contrib 0.164.0; test collector with OTLP/HTTP + TLS (test CA in the system trust store) + basic auth; local collector → single-instance Mimir 2.16 + Loki 3.5, Grafana 11.4.

| Area | Check | Result |
|---|---|---|
| Install | Over an older install; from internal repo (`file://`) and from GitHub | Pass; only the managed fragments, conf and drop-in remain |
| Install | `https://` + Basic token via `sudo -E` | Pass: preflight 200, data arrives; token appears 0 times in the journal |
| Profiles | Install from a profile (name with a prefix), re-run without token, command-line override, profile with `OTEL_TOKEN` / unknown key / malformed line / `http://` endpoint | Token kept on re-run; override applied; package step skipped on re-run; invalid profiles refused; conf records the profile |
| Install | Wrong password | Exit 1 at preflight (401), running agent and config unchanged |
| Install | Invalid inputs: `host:port` or `http://` endpoint, process name > 15 chars, `LOG_PATHS` under `/home`, `http://` repo, malformed `HOST_ATTRIBUTES`, non-boolean flag | Exit 1 before anything is changed |
| Privileges | Running agent | `CapEff=0`, `NoNewPrivs=1`; groups `otelcol-contrib` (+ `systemd-journal` with system logs); `systemd-analyze security` 4.9 OK |
| Privileges | Reading `/etc/shadow`, SSH host key, `/root`, `/proc/<sshd>/environ`, `/proc/<sshd>/mem` | Denied (root outside the sandbox can read them) |
| Logs | journald `err` / `warning` / `authpriv` lines | `error` / `warn` / `info` with `syslog_identifier`, `systemd_unit` |
| Logs | Lines written while the agent was stopped (journald and file) | Collected after start |
| Logs | 0600 application log | Installer warns, file not read |
| Metrics | Three `sleep` processes, same owner | One series = sum of their RSS |
| Metrics | `KEEP_PROCESS_PIDS=true` | One series per pid |
| Metrics | `process.disk.io`, `process.command_line` | Not exported |
| Metrics | Dummy `veth`, bridge, tmpfs, container mount, loop device | Excluded; xfs on `/dev/loop0` still reported |
| Identity | `HOST_ATTRIBUTES`, `host.id`, `host.arch`, `os.description` | On metrics and logs; `instance=<host.name>`, `job=redhat-host` |
| Mimir | Single-instance Mimir 2.16 (multi-tenant, tenant header set by the collector) | `target_info` dropped by relabeling and **no** attribute promotion, as in production; metrics arrive under the tenant only with `host_name`, `deployment_environment_name`, `team`, `business_line`, `role`, `region` as labels from the agent (identical with promotion configured too, no conflict); one series per process name + owner (`sleep` sum = RSS sum) |
| Grafana | Every query and variable of both dashboards through Grafana's Mimir and Loki data sources, with `target_info` dropped | All return data; `role=db` / `business_line=payments` list the host, `role=web` lists none; the link to the other dashboard carries time range and filters |
| Resilience | Collector down 90 s; VM reboot | Replayed without gaps; agent back with offsets kept |
| End to end | Clean host, install from `main` with a dev profile (`dev-app-hk.env`), then switched to a prod profile (`prod-db-hk.env`) without passing the token | Both: service active, 0 restarts; labels follow the profile (`deployment_environment_name`, `role`, `region`); process metrics, journald and file logs in Mimir/Loki; both dashboards show data; token kept on the switch |
| Upgrade | `OTEL_VERSION` 0.164.0 → 0.163.2 → 0.164.0 via re-run | dnf downgrades / upgrades, config unchanged, 0 restarts; a version that does not exist (404) exits 1 with the agent unchanged |
| Resources | Normal load, 2 vCPU (2018 laptop CPU), 30 s interval | Host metrics 0.12% of a core, + processes 0.17%, + journald 0.42%, + file logs 0.66%; ~55–75 MiB anonymous memory |
| Resources | `AGENT_CPU_QUOTA` / `AGENT_MEMORY_MAX`: `0%`, `50`, `300K`, `100M`; 300M/50%, 600M/150%, 1G/300% | Invalid values refused; `MemoryHigh`, `GOMEMLIMIT`, `GOMAXPROCS` and the agent's `limit_mib` match the derived values; an `override.conf` survives a re-run |
| Resources | Log flood 10,000 lines/s | 6–10% of a core (≤ 21% in a 5 s window), host ≥ 86% idle, 0 restarts |
| Resources | Flood with the collector overloaded (Loki 503) and then stopped, before `retry_on_failure` | Memory levelled off at ~150 MiB (cgroup ≤ 214M < `MemoryHigh`): `memory_limiter` refused and data was dropped; queue drained ~10 s after recovery |
| Resources | `MemoryMax` forced to 90M under flood | OOM kill + restart every ~5 s, host unaffected; normal again once restored |
| Resilience | Collector down 150 s while 182,900 file lines and 2,000 journald lines were written (`retry_on_failure`) | All arrived in Loki; 0 refused / failed in the agent; ≤ 154 MiB, ≤ 23% of a core while catching up |
| Resilience | Known gap (not tested, accepted): host reboot while the collector is down | With the default volatile journal, journald lines not shipped yet are lost; the complete copy stays on disk in rsyslog's `/var/log/messages`, `secure` (~4 weeks) |
| Central collector | Backlog flushed after an outage through a collector with an unbounded batch | Batches up to ~7 MB exceeded Loki's 4 MiB gRPC limit and were dropped there; fixed with `send_batch_max_size: 2048` (see [Logs](#logs)) |

## Files

| Path | Description |
|---|---|
| `redhat-install.sh` | installer |
| `agent/*.yaml` | agent config fragments |
| `grafana/redhat-host-metrics.json`, `grafana/redhat-host-logs.json` | Grafana dashboards (Mimir + Loki) |
