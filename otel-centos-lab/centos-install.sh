#!/usr/bin/env bash
# CentOS Stream / RHEL / Rocky / Alma: install otelcol-contrib as host agent
# (OS metrics + file logs) and ship to a central OpenTelemetry Collector.
#
# Usage:
#   export COLLECTOR_ENDPOINT=otel-gateway.example.com:4317
#   sudo bash centos-install.sh
#
# Optional:
#   OTEL_VERSION=0.164.0
#   RPM_PATH=/path/to/otelcol-contrib_*.rpm
#   RPM_SHA256=<64 hex chars>                       # expected sha256 of RPM_PATH (recommended offline); unset = fetch ${RPM_URL}.sha256
#   SKIP_RPM_VERIFY=true|false                      # default false; true only for an offline RPM_PATH with no digest (skips integrity check, unsafe)
#   WORKDIR=/path                                   # default: fresh mktemp -d, removed on exit; an explicit WORKDIR is not removed
#   TLS_CA_FILE=/path/ca.crt
#   TLS_CERT_FILE=/path/client.crt
#   TLS_KEY_FILE=/path/client.key
#   OTEL_TOKEN=...
#   TLS_INSECURE=true|false                         # with OTEL_TOKEN but no TLS, TLS_INSECURE=true is required to send the token in clear text
#   LOG_PATHS="/var/log/messages /var/log/secure"   # file_log paths, space-separated
#   ENABLE_LOGS=true|false                          # default true
#   SERVICE_NAME=centos-host                        # service.name (Loki service_name, Prometheus job); only [A-Za-z0-9._-]
#   STORAGE_DIR=/var/lib/otelcol-contrib/file_storage  # file_log offset storage, so reading resumes after a restart
#   KEEP_PROCESS_PIDS=true|false                    # default false: drop pid & co. and SUM same-name, same-owner processes into one series;
#                                                   # true = one series per process (with process.pid), for debugging only
#   ENABLE_PROCESS_METRICS=true|false               # default true; per-process CPU/memory/IO
#   PROCESS_NAMES="rsyslogd sshd otelcol-contrib"   # space- or comma-separated; unset = ALL processes (noisy, lab only)
#   PROCESS_MATCH_TYPE=strict|regexp                # default strict (exact process name)
#   PROCESS_CAPS=true|false                         # default true; systemd drop-in with CAP_SYS_PTRACE+CAP_DAC_READ_SEARCH,
#                                                   # needed to read other users' /proc/<pid>/io and exe (process.disk.io, executable.path)
set -euo pipefail

OTEL_VERSION="${OTEL_VERSION:-0.164.0}"
COLLECTOR_ENDPOINT="${COLLECTOR_ENDPOINT:-REPLACE_ME:4317}"
TLS_CA_FILE="${TLS_CA_FILE:-}"
TLS_CERT_FILE="${TLS_CERT_FILE:-}"
TLS_KEY_FILE="${TLS_KEY_FILE:-}"
OTEL_TOKEN="${OTEL_TOKEN:-}"
CERTS_DIR="${CERTS_DIR:-/etc/otelcol-contrib/certs}"
ENABLE_LOGS="${ENABLE_LOGS:-true}"
SERVICE_NAME="${SERVICE_NAME:-centos-host}"
STORAGE_DIR="${STORAGE_DIR:-/var/lib/otelcol-contrib/file_storage}"
# Usual CentOS/RHEL system logs; override with LOG_PATHS
LOG_PATHS="${LOG_PATHS:-/var/log/messages /var/log/secure}"
ENABLE_PROCESS_METRICS="${ENABLE_PROCESS_METRICS:-true}"
PROCESS_NAMES="${PROCESS_NAMES:-}"
PROCESS_MATCH_TYPE="${PROCESS_MATCH_TYPE:-strict}"
PROCESS_CAPS="${PROCESS_CAPS:-true}"
KEEP_PROCESS_PIDS="${KEEP_PROCESS_PIDS:-false}"
case "$KEEP_PROCESS_PIDS" in
  true|false) ;;
  *) echo "KEEP_PROCESS_PIDS must be true or false (got: $KEEP_PROCESS_PIDS)"; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) RPM_ARCH=amd64 ;;
  aarch64|arm64) RPM_ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac

RPM_NAME="otelcol-contrib_${OTEL_VERSION}_linux_${RPM_ARCH}.rpm"
RPM_URL="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_VERSION}/${RPM_NAME}"
RPM_SHA256="${RPM_SHA256:-}"
SKIP_RPM_VERIFY="${SKIP_RPM_VERIFY:-false}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root or with sudo"
  exit 1
fi

# Work dir: by default a fresh mktemp -d (0700, unpredictable) removed on exit;
# an explicitly set WORKDIR is used as is (and not removed).
# Never a fixed /tmp path: a local unprivileged user could plant an RPM there that root then installs.
if [[ -n "${WORKDIR:-}" ]]; then
  mkdir -p "$WORKDIR"
else
  WORKDIR="$(mktemp -d /tmp/otelcol-install.XXXXXXXX)"
  trap 'rm -rf "$WORKDIR"' EXIT
fi

install_secret_file() {
  local src="$1" dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "File not found: $src"
    exit 1
  fi
  install -d -m 0755 "$(dirname "$dest")"
  install -m 0640 -o root -g otelcol-contrib "$src" "$dest" 2>/dev/null \
    || install -m 0640 "$src" "$dest"
}

if [[ -n "$TLS_CERT_FILE" && -z "$TLS_KEY_FILE" ]] || [[ -z "$TLS_CERT_FILE" && -n "$TLS_KEY_FILE" ]]; then
  echo "TLS_CERT_FILE and TLS_KEY_FILE must be given together"
  exit 1
fi

CA_PATH=""
CERT_PATH=""
KEY_PATH=""
if [[ -n "$TLS_CA_FILE" ]]; then
  CA_PATH="${CERTS_DIR}/ca.crt"
  install_secret_file "$TLS_CA_FILE" "$CA_PATH"
fi
if [[ -n "$TLS_CERT_FILE" ]]; then
  CERT_PATH="${CERTS_DIR}/client.crt"
  KEY_PATH="${CERTS_DIR}/client.key"
  install_secret_file "$TLS_CERT_FILE" "$CERT_PATH"
  install_secret_file "$TLS_KEY_FILE" "$KEY_PATH"
  chmod 0640 "$KEY_PATH" || true
fi

if [[ -n "${TLS_INSECURE:-}" ]]; then
  INSECURE="$TLS_INSECURE"
elif [[ -n "$CA_PATH" || -n "$CERT_PATH" ]]; then
  INSECURE=false
else
  INSECURE=true
fi

# Never send the bearer token in clear text silently
if [[ -n "$OTEL_TOKEN" && "$INSECURE" == "true" ]]; then
  if [[ "${TLS_INSECURE:-}" == "true" ]]; then
    echo "WARNING: OTEL_TOKEN will be sent in CLEAR TEXT (tls.insecure=true) and can be captured by anyone on the network. Trusted networks / labs only."
  else
    echo "ERROR: OTEL_TOKEN is set but TLS is not configured (TLS_CA_FILE / TLS_CERT_FILE), so the token would be sent in clear text."
    echo "  Provide TLS_CA_FILE (recommended), or set TLS_INSECURE=true explicitly to accept the risk."
    exit 1
  fi
fi

TLS_YAML="    tls:
      insecure: ${INSECURE}"
if [[ -n "$CA_PATH" ]]; then
  TLS_YAML+=$'\n'"      ca_file: ${CA_PATH}"
fi
if [[ -n "$CERT_PATH" ]]; then
  TLS_YAML+=$'\n'"      cert_file: ${CERT_PATH}"
  TLS_YAML+=$'\n'"      key_file: ${KEY_PATH}"
fi

HEADERS_YAML=""
if [[ -n "$OTEL_TOKEN" ]]; then
  HEADERS_YAML=$'\n'"    headers:"$'\n'"      authorization: \"Bearer \${env:OTEL_TOKEN}\""
fi

# Build file_log include list YAML
FILELOG_INCLUDE=""
set -f  # do not expand LOG_PATHS globs at install time; file_log matches them at runtime
for p in $LOG_PATHS; do
  FILELOG_INCLUDE+=$'\n'"      - ${p}"
done
set +f

case "$ENABLE_LOGS" in
  true|false) ;;
  *) echo "ENABLE_LOGS must be true or false (got: ${ENABLE_LOGS})"; exit 1 ;;
esac
if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "SERVICE_NAME may only contain letters, digits and . _ - (got: ${SERVICE_NAME})"
  exit 1
fi
case "$ENABLE_PROCESS_METRICS" in
  true|false) ;;
  *) echo "ENABLE_PROCESS_METRICS must be true or false (got: ${ENABLE_PROCESS_METRICS})"; exit 1 ;;
esac
case "$PROCESS_CAPS" in
  true|false) ;;
  *) echo "PROCESS_CAPS must be true or false (got: ${PROCESS_CAPS})"; exit 1 ;;
esac
case "$PROCESS_MATCH_TYPE" in
  strict|regexp) ;;
  *) echo "PROCESS_MATCH_TYPE must be strict or regexp (got: ${PROCESS_MATCH_TYPE})"; exit 1 ;;
esac

# process scraper: PROCESS_NAMES split on spaces/commas -> include.names
# Note: Linux process names (comm) are at most 15 chars; comma/space are separators, so a regexp cannot contain them (use | for alternation)
PROCESS_NAME_LIST=()
if [[ "$ENABLE_PROCESS_METRICS" == "true" && -n "$PROCESS_NAMES" ]]; then
  read -r -a PROCESS_NAME_LIST <<< "${PROCESS_NAMES//,/ }"
fi

PROCESS_FILTER_YAML=""
if [[ "${#PROCESS_NAME_LIST[@]}" -gt 0 ]]; then
  PROCESS_FILTER_YAML=$'\n'"        include:"$'\n'"          match_type: ${PROCESS_MATCH_TYPE}"$'\n'"          names:"
  for n in "${PROCESS_NAME_LIST[@]}"; do
    esc="${n//\'/\'\'}"
    PROCESS_FILTER_YAML+=$'\n'"            - '${esc}'"
  done
fi

if [[ "$ENABLE_PROCESS_METRICS" == "true" ]]; then
  PROCESS_SCRAPER="
      process:
        # otelcol-contrib runs as non-root: reading other users' exe/io/user gives EACCES, mute those errors
        mute_process_name_error: true
        mute_process_exe_error: true
        mute_process_io_error: true
        mute_process_user_error: true
        mute_process_cgroup_error: true${PROCESS_FILTER_YAML}
        metrics:
          process.cpu.time:
            enabled: true
          process.cpu.utilization:
            enabled: true
          process.memory.usage:
            enabled: true
          process.memory.virtual:
            enabled: true
          process.disk.io:
            enabled: true"
else
  PROCESS_SCRAPER=""
fi

# Fetch the official per-asset sha256 (64 hex chars, maybe followed by the file name); non-zero on failure
fetch_rpm_sha256() {
  local out hex
  out="$(curl -fsSL --retry 3 "${RPM_URL}.sha256")" || return 1
  hex="$(awk 'NR==1 {print $1}' <<< "$out")"
  [[ "$hex" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  echo "${hex,,}"
}

RPM_FILE="${WORKDIR}/${RPM_NAME}"
rm -f "$RPM_FILE"
VERIFY=true
if [[ -n "${RPM_PATH:-}" ]]; then
  if [[ ! -f "$RPM_PATH" ]]; then
    echo "RPM_PATH not found: $RPM_PATH"
    exit 1
  fi
  # Copy into the private WORKDIR first, then verify/install that copy (no swap after verification, TOCTOU)
  install -m 0600 "$RPM_PATH" "$RPM_FILE"
else
  echo "Downloading $RPM_URL ..."
  curl -fL --retry 3 -o "$RPM_FILE" "$RPM_URL"
fi

if [[ -n "$RPM_SHA256" ]]; then
  if [[ ! "$RPM_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "RPM_SHA256 must be a 64-character hex sha256"
    exit 1
  fi
  EXPECTED_SHA256="${RPM_SHA256,,}"
elif EXPECTED_SHA256="$(fetch_rpm_sha256)"; then
  :
elif [[ -n "${RPM_PATH:-}" && "$SKIP_RPM_VERIFY" == "true" ]]; then
  VERIFY=false
  echo "!!!!!! WARNING: no sha256 available for the RPM and SKIP_RPM_VERIFY=true: installing it as root WITHOUT any integrity check !!!!!!"
  echo "!!!!!! Make sure ${RPM_PATH} comes from a trusted source; prefer RPM_SHA256=<digest> !!!!!!"
else
  echo "ERROR: cannot fetch ${RPM_URL}.sha256, so the RPM cannot be verified."
  if [[ -n "${RPM_PATH:-}" ]]; then
    echo "  For an offline install set RPM_SHA256=<64-char sha256> (recommended), or SKIP_RPM_VERIFY=true to accept the risk."
  fi
  exit 1
fi

if [[ "$VERIFY" == "true" ]]; then
  ACTUAL_SHA256="$(sha256sum "$RPM_FILE" | awk '{print $1}')"
  if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
    echo "ERROR: RPM sha256 mismatch, refusing to install."
    echo "  expected: $EXPECTED_SHA256"
    echo "  actual:   $ACTUAL_SHA256"
    exit 1
  fi
  echo "RPM sha256 OK: $ACTUAL_SHA256"
fi

echo "Installing RPM: $RPM_FILE"
if command -v dnf >/dev/null 2>&1; then
  dnf install -y "$RPM_FILE"
elif command -v yum >/dev/null 2>&1; then
  yum install -y "$RPM_FILE"
else
  rpm -ivh "$RPM_FILE"
fi

if id otelcol-contrib >/dev/null 2>&1; then
  if [[ -d "$CERTS_DIR" ]]; then
    chown -R root:otelcol-contrib "$CERTS_DIR" || true
    chmod 0750 "$CERTS_DIR" || true
    [[ -n "$CA_PATH" ]] && chmod 0640 "$CA_PATH" || true
    [[ -n "$CERT_PATH" ]] && chmod 0640 "$CERT_PATH" || true
    [[ -n "$KEY_PATH" ]] && chmod 0640 "$KEY_PATH" || true
  fi
  # reading /var/log/messages and secure usually needs the adm group
  if getent group adm >/dev/null 2>&1; then
    usermod -aG adm otelcol-contrib || true
  fi
fi

CONFIG=/etc/otelcol-contrib/config.yaml
CONF=/etc/otelcol-contrib/otelcol-contrib.conf
BACKUP_SUFFIX="$(date +%Y%m%d%H%M%S)"
[[ -f "$CONFIG" ]] && cp -a "$CONFIG" "${CONFIG}.bak.${BACKUP_SUFFIX}"

if [[ "${ENABLE_LOGS}" == "true" ]]; then
  FILELOG_RECEIVER="
  file_log:
    include:${FILELOG_INCLUDE}
    exclude:
      - \"**/*.gz\"
      - \"**/*.[0-9]\"
    start_at: end
    # persist read offsets: after an agent/host restart, resume where it stopped instead of skipping lines written meanwhile
    storage: file_storage
    include_file_path: true
    include_file_name: true
"
  LOGS_PIPELINE="
    logs:
      receivers: [file_log]
      processors: [memory_limiter, resource/service, resource_detection, batch]
      exporters: [otlp_grpc]
"
  EXTENSIONS_YAML="
extensions:
  file_storage:
    directory: ${STORAGE_DIR}
    create_directory: true
"
  SERVICE_EXTENSIONS="
  extensions: [file_storage]"
else
  FILELOG_RECEIVER=""
  LOGS_PIPELINE=""
  EXTENSIONS_YAML=""
  SERVICE_EXTENSIONS=""
fi

# Process metrics: once pid & co. are dropped, several processes with the same name and owner (nginx/php-fpm workers...)
# end up on the same series and overwrite each other. So move name/owner onto the data points, regroup by them, then sum.
# KEEP_PROCESS_PIDS=true skips every transform statement: pid stays on the resource and each process stays its own series.
if [[ "$ENABLE_PROCESS_METRICS" == "true" ]]; then
  PROCESS_PROCESSORS_YAML='
  transform/process_identity:
    error_mode: ignore
    metric_statements:
      - context: datapoint
        conditions:
          - IsMatch(metric.name, "^process\\.") and "${env:KEEP_PROCESS_PIDS:-false}" != "true"
        statements:
          - set(datapoint.attributes["process.executable.name"], resource.attributes["process.executable.name"])
          - set(datapoint.attributes["process.owner"], resource.attributes["process.owner"]) where resource.attributes["process.owner"] != nil
          # start_time differs per process; aligning it lets metrics_transform merge the points
          - set(datapoint.start_time_unix_nano, 0)
          - set(datapoint.time, TruncateTime(datapoint.time, Duration("1s")))
      # command_line can carry secrets (e.g. "mysql -pSECRET"): never let it leave the host, debug mode included
      - context: resource
        statements:
          - delete_key(resource.attributes, "process.command_line")
          - delete_key(resource.attributes, "process.command")
      - context: resource
        conditions:
          - "\"${env:KEEP_PROCESS_PIDS:-false}\" != \"true\""
        statements:
          - delete_matching_keys(resource.attributes, "^process\\.")
  groupbyattrs/processes:
    keys: [process.executable.name, process.owner]
  metrics_transform/sum_processes:
    transforms:
      - include: ^process\.memory\.
        match_type: regexp
        action: update
        operations:
          - {action: aggregate_labels, label_set: [], aggregation_type: sum}
      - include: ^process\.cpu\.
        match_type: regexp
        action: update
        operations:
          - {action: aggregate_labels, label_set: [state], aggregation_type: sum}
      - include: process.disk.io
        action: update
        operations:
          - {action: aggregate_labels, label_set: [direction], aggregation_type: sum}'
  PROCESS_PROCESSOR_LIST="transform/process_identity, groupbyattrs/processes, metrics_transform/sum_processes, "
else
  PROCESS_PROCESSORS_YAML=""
  PROCESS_PROCESSOR_LIST=""
fi

cat > "$CONFIG" << YAML
# otelcol-contrib host agent — OS metrics + optional file logs
# Generated by centos-install.sh (otelcol-contrib ${OTEL_VERSION})
${EXTENSIONS_YAML}
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
        # Skip pseudo/removable devices (loop: snaps & images, ram/zram, sr: CD-ROM)
        exclude:
          devices: ['^(loop|ram|zram|sr|fd)[0-9]+$']
          match_type: regexp
      filesystem:
        # Only real filesystems: container overlays, tmpfs and pseudo filesystems would add series per container/mount
        exclude_fs_types:
          fs_types: [autofs, binfmt_misc, bpf, cgroup, cgroup2, configfs, debugfs, devpts, devtmpfs, fusectl, hugetlbfs, iso9660, mqueue, nsfs, overlay, proc, pstore, rpc_pipefs, securityfs, selinuxfs, squashfs, sysfs, tmpfs, tracefs]
          match_type: strict
        exclude_mount_points:
          mount_points: ['^/(dev|proc|sys|run)($|/)', '^/var/lib/(docker|containers|kubelet)/']
          match_type: regexp
      network:
        # Per-container / per-VM virtual interfaces churn (new names on every restart)
        exclude:
          interfaces: ['^(lo|veth.*|docker.*|br-.*|cni.*|cali.*|flannel.*|cilium.*|lxc.*|virbr.*|vnet.*)$']
          match_type: regexp
      load:
      paging:
      processes:${PROCESS_SCRAPER}
${FILELOG_RECEIVER}
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 256
    spike_limit_mib: 64${PROCESS_PROCESSORS_YAML}
  resource/service:
    attributes:
      - key: service.name
        value: ${SERVICE_NAME}
        action: insert
  resource_detection:
    detectors: [system, env]
    system:
      hostname_sources: [os]
  batch:
    send_batch_size: 1024
    timeout: 10s

exporters:
  otlp_grpc:
    endpoint: \${env:COLLECTOR_ENDPOINT}
${TLS_YAML}${HEADERS_YAML}

service:${SERVICE_EXTENSIONS}
  pipelines:
    metrics:
      receivers: [host_metrics]
      processors: [memory_limiter, ${PROCESS_PROCESSOR_LIST}resource/service, resource_detection, batch]
      exporters: [otlp_grpc]
${LOGS_PIPELINE}
  telemetry:
    logs:
      level: info
YAML

if [[ -f "$CONF" ]]; then
  cp -a "$CONF" "${CONF}.bak.${BACKUP_SUFFIX}"
fi
{
  echo "# Managed by centos-install.sh"
  if [[ -f "${CONF}.bak.${BACKUP_SUFFIX}" ]]; then
    grep -E '^OTELCOL_OPTIONS=' "${CONF}.bak.${BACKUP_SUFFIX}" || echo 'OTELCOL_OPTIONS="--config=/etc/otelcol-contrib/config.yaml"'
  else
    echo 'OTELCOL_OPTIONS="--config=/etc/otelcol-contrib/config.yaml"'
  fi
  echo "COLLECTOR_ENDPOINT=${COLLECTOR_ENDPOINT}"
  echo "KEEP_PROCESS_PIDS=${KEEP_PROCESS_PIDS}"
  if [[ -n "$OTEL_TOKEN" ]]; then
    echo "OTEL_TOKEN=${OTEL_TOKEN}"
  fi
} > "$CONF"
chmod 0640 "$CONF" || true
if id otelcol-contrib >/dev/null 2>&1; then
  chown root:otelcol-contrib "$CONF" || true
fi

echo
echo "Auth settings:"
echo "  tls.insecure=${INSECURE}"
[[ -n "$CA_PATH" ]] && echo "  ca_file=${CA_PATH}"
[[ -n "$CERT_PATH" ]] && echo "  cert_file=${CERT_PATH} key_file=${KEY_PATH}"
[[ -n "$OTEL_TOKEN" ]] && echo "  headers.authorization=Bearer \${OTEL_TOKEN} (from ${CONF})"
echo "service.name=${SERVICE_NAME}"
if [[ "${ENABLE_LOGS}" == "true" ]]; then
  echo "Log collection (file_log): ${LOG_PATHS}  (offsets kept in ${STORAGE_DIR})"
else
  echo "Log collection: disabled (ENABLE_LOGS=false)"
fi
if [[ "$KEEP_PROCESS_PIDS" == "true" ]]; then
  echo "Process metrics: one series per process, process.pid kept (KEEP_PROCESS_PIDS=true, debugging only)"
else
  echo "Process metrics: same-name, same-owner processes summed into one series, no pid (default, avoids high cardinality)"
fi
if [[ "$ENABLE_PROCESS_METRICS" != "true" ]]; then
  echo "Process metrics (process scraper): disabled (ENABLE_PROCESS_METRICS=false)"
elif [[ "${#PROCESS_NAME_LIST[@]}" -gt 0 ]]; then
  echo "Process metrics (process scraper): match_type=${PROCESS_MATCH_TYPE} names=${PROCESS_NAME_LIST[*]}"
else
  echo "WARNING: PROCESS_NAMES is not set, so ALL processes are collected (high cardinality, noisy; lab use only). Set PROCESS_NAMES in production."
fi

# Non-root otelcol-contrib cannot read other users' /proc/<pid>/io (mode 0400) or /proc/<pid>/exe:
#   CAP_SYS_PTRACE       -> passes the ptrace access check on /proc/<pid>/io and /proc/<pid>/exe
#   CAP_DAC_READ_SEARCH  -> passes the 0400 file mode on /proc/<pid>/io
# Tested on CentOS Stream 9: without CAP_SYS_PTRACE, process.disk.io is missing for every process not owned by the collector.
DROPIN_DIR=/etc/systemd/system/otelcol-contrib.service.d
DROPIN_FILE="${DROPIN_DIR}/10-process-metrics.conf"
if [[ "$ENABLE_PROCESS_METRICS" == "true" && "$PROCESS_CAPS" == "true" ]]; then
  install -d -m 0755 "$DROPIN_DIR"
  cat > "$DROPIN_FILE" << 'UNIT'
# Managed by centos-install.sh — per-process metrics need to read other users' /proc/<pid>/{io,exe}
[Service]
AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
UNIT
  echo "systemd drop-in: ${DROPIN_FILE} (CAP_SYS_PTRACE CAP_DAC_READ_SEARCH)"
else
  rm -f "$DROPIN_FILE"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
  if [[ "$ENABLE_PROCESS_METRICS" == "true" ]]; then
    # /proc/<pid>/io is also gated by a ptrace access check, so without CAP_SYS_PTRACE process.disk.io is
    # missing for every process the collector does not own, even though the log drop-in grants CAP_DAC_READ_SEARCH.
    echo "PROCESS_CAPS=false: CAP_SYS_PTRACE not granted; process.disk.io (and executable.path) will be missing for other users' processes"
  fi
fi

# On CentOS/RHEL /var/log/messages and secure are root:root 0600 by default, so the adm group cannot read them;
# CAP_DAC_READ_SEARCH (read-only permission bypass) is more robust than running as root or chmod-ing logs, and survives logrotate re-creating the files.
DROPIN_DIR=/etc/systemd/system/otelcol-contrib.service.d
DROPIN="${DROPIN_DIR}/10-read-logs.conf"
if [[ "${ENABLE_LOGS}" == "true" ]]; then
  install -d -m 0755 "$DROPIN_DIR"
  cat > "$DROPIN" << 'UNIT'
[Service]
AmbientCapabilities=CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_DAC_READ_SEARCH
UNIT
else
  rm -f "$DROPIN"
fi

if [[ "${ENABLE_LOGS}" == "true" ]]; then
  install -d -m 0750 "$STORAGE_DIR"
  chown otelcol-contrib:otelcol-contrib "$STORAGE_DIR" 2>/dev/null || true
fi

# Keep only the 5 newest backups (conf backups contain OTEL_TOKEN and must not pile up)
for f in "$CONFIG" "$CONF"; do
  ls -1t "${f}".bak.* 2>/dev/null | tail -n +6 | xargs -r rm -f --
done

# Validate the new config first; on failure restore the old one, so a running agent is never switched to a config that cannot start
# Variables are passed as prefix assignments (not in argv), so the token does not show up in ps
if ! COLLECTOR_ENDPOINT="$COLLECTOR_ENDPOINT" KEEP_PROCESS_PIDS="$KEEP_PROCESS_PIDS" OTEL_TOKEN="$OTEL_TOKEN" \
    runuser -u otelcol-contrib -- /usr/bin/otelcol-contrib validate --config="$CONFIG"; then
  echo "ERROR: the generated config failed otelcol-contrib validate; the previous config was restored and the agent was not restarted."
  if [[ -f "${CONFIG}.bak.${BACKUP_SUFFIX}" ]]; then
    cp -a "${CONFIG}.bak.${BACKUP_SUFFIX}" "$CONFIG"
    [[ -f "${CONF}.bak.${BACKUP_SUFFIX}" ]] && cp -a "${CONF}.bak.${BACKUP_SUFFIX}" "$CONF"
  fi
  exit 1
fi

if [[ "$COLLECTOR_ENDPOINT" == "REPLACE_ME:4317" ]]; then
  echo "WARNING: COLLECTOR_ENDPOINT is still the placeholder; edit ${CONF} before starting"
  echo "Example: COLLECTOR_ENDPOINT=10.0.0.20:4317"
  systemctl daemon-reload
  systemctl enable otelcol-contrib
  echo "Enabled but not started. After setting the endpoint run: systemctl start otelcol-contrib"
  exit 0
fi

systemctl daemon-reload
systemctl enable otelcol-contrib
systemctl restart otelcol-contrib
# Type=simple + Restart=on-failure: restart itself always succeeds, so wait a few seconds and check the process did not exit and restart
sleep 8
if [[ "$(systemctl show -p ActiveState --value otelcol-contrib)" != "active" || "$(systemctl show -p NRestarts --value otelcol-contrib)" != "0" ]]; then
  echo "ERROR: otelcol-contrib is not running steadily after start; recent log:"
  journalctl -u otelcol-contrib -n 20 --no-pager || true
  exit 1
fi
systemctl --no-pager --full status otelcol-contrib || true
echo
echo "Logs:   journalctl -u otelcol-contrib -f"
echo "Config: $CONFIG"
echo "Env:    $CONF  (COLLECTOR_ENDPOINT=$COLLECTOR_ENDPOINT)"
