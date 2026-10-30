# Per-process metrics evidence (CentOS Stream 9, otelcol-contrib 0.164.0)

Environment: podman (`quay.io/centos/centos:stream9` + systemd, rsyslog, sshd), agent installed with
`centos-install.sh`, shipping OTLP/gRPC to a gateway collector on the host (`file/metrics` exporter).

```bash
COLLECTOR_ENDPOINT=10.88.0.1:4317 PROCESS_NAMES="rsyslogd, sshd,otelcol-contrib" \
  ENABLE_LOGS=false RPM_PATH=./otelcol-contrib_0.164.0_linux_amd64.rpm bash centos-install.sh
```

Latest data points per process as received at the gateway (`process.cpu.utilization` is a gauge in
CPU-seconds/second; it needs two scrapes, so it only appears from the second batch):

```
process.executable.name=otelcol-contrib process.pid=303 owner=otelcol-contrib path=/usr/bin/otelcol-contrib | process.cpu.time: state=user=0.12, state=system=0.03, state=wait=0
process.executable.name=otelcol-contrib process.pid=303 owner=otelcol-contrib path=/usr/bin/otelcol-contrib | process.cpu.utilization: state=user=8.33311970714314e-05, state=system=0, state=wait=0
process.executable.name=otelcol-contrib process.pid=303 owner=otelcol-contrib path=/usr/bin/otelcol-contrib | process.disk.io: direction=read=185162, direction=write=9169
process.executable.name=otelcol-contrib process.pid=303 owner=otelcol-contrib path=/usr/bin/otelcol-contrib | process.memory.usage: -=220381184
process.executable.name=otelcol-contrib process.pid=303 owner=otelcol-contrib path=/usr/bin/otelcol-contrib | process.memory.virtual: -=1781219328
process.executable.name=rsyslogd process.pid=29 owner=root path=/usr/sbin/rsyslogd | process.cpu.time: state=user=0.04, state=system=0.03, state=wait=0
process.executable.name=rsyslogd process.pid=29 owner=root path=/usr/sbin/rsyslogd | process.cpu.utilization: state=user=8.33312594155038e-05, state=system=0, state=wait=0
process.executable.name=rsyslogd process.pid=29 owner=root path=/usr/sbin/rsyslogd | process.disk.io: direction=read=599109, direction=write=87980
process.executable.name=rsyslogd process.pid=29 owner=root path=/usr/sbin/rsyslogd | process.memory.usage: -=6774784
process.executable.name=rsyslogd process.pid=29 owner=root path=/usr/sbin/rsyslogd | process.memory.virtual: -=169168896
process.executable.name=sshd process.pid=55 owner=root path=/usr/sbin/sshd | process.cpu.time: state=user=0, state=system=0, state=wait=0
process.executable.name=sshd process.pid=55 owner=root path=/usr/sbin/sshd | process.cpu.utilization: state=user=0, state=system=0, state=wait=0
process.executable.name=sshd process.pid=55 owner=root path=/usr/sbin/sshd | process.disk.io: direction=read=46072, direction=write=48
process.executable.name=sshd process.pid=55 owner=root path=/usr/sbin/sshd | process.memory.usage: -=8155136
process.executable.name=sshd process.pid=55 owner=root path=/usr/sbin/sshd | process.memory.virtual: -=12079104
```

Only the three requested executables appear (`match_type: strict`). Resource attributes on each metric
include `process.pid`, `process.parent_pid`, `process.executable.name`, `process.executable.path`,
`process.command`, `process.command_line`, `process.owner`, `host.name`.

## Other runs

| Run | Result |
|-----|--------|
| `PROCESS_MATCH_TYPE=regexp PROCESS_NAMES="^ssh,rsyslog"` | `sshd` + `rsyslogd` only (regexp is unanchored `MatchString`) |
| `ENABLE_PROCESS_METRICS=false` | no `processscraper` scope at gateway, no `process:` in config, drop-in removed |
| `PROCESS_NAMES` unset (all processes) | 112 process metrics in ~2 scrapes for 8 processes in a minimal container: `systemd`, `systemd-journald`, `systemd-logind`, `dbus-broker`, `dbus-broker-launch`, `rsyslogd`, `sshd`, `otelcol-contrib`; installer prints a warning |

## Permissions findings (collector runs as `otelcol-contrib`, non-root)

| Setup | Result |
|-------|--------|
| no extra caps, mute_* on | cpu/memory for root processes OK; **no `process.disk.io`** and empty `process.executable.path` for root processes; no log noise |
| no extra caps, mute_* off | `Error scraping metrics` every interval: `readlink /proc/<pid>/exe: permission denied` for **every** pid (even ones filtered out by `include`) |
| `CAP_SYS_PTRACE` only | exe path OK; `open /proc/<pid>/io: permission denied` remains (`/proc/<pid>/io` is mode 0400 root) |
| `CAP_SYS_PTRACE` + `CAP_DAC_READ_SEARCH` | all metrics + attributes present, 0 scrape errors even with mute_* off |
