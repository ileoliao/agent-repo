#!/usr/bin/env bash
# CentOS Stream / RHEL / Rocky / Alma: install otelcol-contrib as host agent
# (host metrics, system logs from journald, optional application log files) and ship to a central
# OpenTelemetry Collector. The agent runs without capabilities and in a systemd sandbox.
#
# Usage:
#   export COLLECTOR_ENDPOINT=https://otel-gateway.example.com:4318   # URL = OTLP/HTTP; host:port = OTLP/gRPC
#   sudo -E bash centos-install.sh
#
# Optional:
#   OTEL_VERSION=0.164.0
#   REPO_URL=https://repo.example.com/otel/el9/        # internal yum repo, used only for this install (no .repo file is written)
#   RPM_PATH=/path/to/otelcol-contrib_*.rpm
#   WORKDIR=/path                                   # default: fresh mktemp -d, removed on exit; an explicit WORKDIR is not removed
#   TLS_CA_FILE=/path/ca.crt
#   TLS_CERT_FILE=/path/client.crt
#   TLS_KEY_FILE=/path/client.key
#   OTEL_TOKEN=...                                  # sent as "Authorization: <OTEL_AUTH_SCHEME> <OTEL_TOKEN>"
#   OTEL_TOKEN_FILE=/path                           # read the token from this file instead (keeps it out of argv and shell history)
#   OTEL_AUTH_SCHEME=Bearer|Basic                   # default Bearer; Basic = OTEL_TOKEN is base64("user:password")
#   TLS_INSECURE=true|false                         # gRPC: tls.insecure; with OTEL_TOKEN over a clear-text connection, TLS_INSECURE=true is required
#   HOST_ATTRIBUTES="deployment.environment.name=prod,datacenter=sh1,team=infra"   # extra resource attributes for this host
#   SYSTEM_LOGS=true|false                          # default true: system logs from journald (priority info and above)
#   LOG_PATHS="/var/log/myapp/*.log"                # application log files (file_log), space-separated; default: none
#   LOG_CAPS=true|false                             # default false; true grants CAP_DAC_READ_SEARCH so LOG_PATHS files the agent cannot read
#                                                   # are read anyway -- the agent can then read ANY file (/etc/shadow...). Transition only.
#   SERVICE_NAME=centos-host                        # service.name (Loki service_name, Prometheus job); only [A-Za-z0-9._-]
#   STORAGE_DIR=/var/lib/otelcol-contrib/file_storage  # journald cursor / file offsets, so reading resumes after a restart
#   KEEP_PROCESS_PIDS=true|false                    # default false: drop pid & co. and SUM same-name, same-owner processes into one series;
#                                                   # true = one series per process (with process.pid), for debugging only
#   ENABLE_PROCESS_METRICS=true|false               # default true; per-process CPU/memory
#   PROCESS_NAMES="rsyslogd sshd otelcol-contrib"   # space- or comma-separated; unset = ALL processes (noisy, lab only)
#   PROCESS_MATCH_TYPE=strict|regexp                # default strict (exact process name)
set -euo pipefail

OTEL_VERSION="${OTEL_VERSION:-0.164.0}"
COLLECTOR_ENDPOINT="${COLLECTOR_ENDPOINT:-REPLACE_ME:4317}"
TLS_CA_FILE="${TLS_CA_FILE:-}"
TLS_CERT_FILE="${TLS_CERT_FILE:-}"
TLS_KEY_FILE="${TLS_KEY_FILE:-}"
OTEL_TOKEN="${OTEL_TOKEN:-}"
OTEL_AUTH_SCHEME="${OTEL_AUTH_SCHEME:-Bearer}"
HOST_ATTRIBUTES="${HOST_ATTRIBUTES:-}"
REPO_URL="${REPO_URL:-}"
CERTS_DIR="${CERTS_DIR:-/etc/otelcol-contrib/certs}"
SYSTEM_LOGS="${SYSTEM_LOGS:-true}"
LOG_CAPS="${LOG_CAPS:-false}"
SERVICE_NAME="${SERVICE_NAME:-centos-host}"
STORAGE_DIR="${STORAGE_DIR:-/var/lib/otelcol-contrib/file_storage}"
LOG_PATHS="${LOG_PATHS:-}"
ENABLE_PROCESS_METRICS="${ENABLE_PROCESS_METRICS:-true}"
PROCESS_NAMES="${PROCESS_NAMES:-}"
PROCESS_MATCH_TYPE="${PROCESS_MATCH_TYPE:-strict}"
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

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root or with sudo"
  exit 1
fi

# Removed options: refuse them instead of silently doing something else (ENABLE_LOGS=false would now still ship system logs)
for legacy in ENABLE_LOGS PROCESS_CAPS; do
  if [[ -n "${!legacy:-}" ]]; then
    echo "ERROR: ${legacy} was removed. Logs: SYSTEM_LOGS (journald) and LOG_PATHS (files); per-process capabilities are no longer granted."
    exit 1
  fi
done

if [[ -n "${OTEL_TOKEN_FILE:-}" ]]; then
  [[ -z "$OTEL_TOKEN" ]] || { echo "ERROR: set OTEL_TOKEN or OTEL_TOKEN_FILE, not both"; exit 1; }
  [[ -r "$OTEL_TOKEN_FILE" ]] || { echo "ERROR: cannot read OTEL_TOKEN_FILE: $OTEL_TOKEN_FILE"; exit 1; }
  OTEL_TOKEN="$(tr -d '\r\n' < "$OTEL_TOKEN_FILE")"
fi

# These values end up in YAML and in a systemd EnvironmentFile: no whitespace or control characters
# (a newline could inject extra lines such as OTELCOL_OPTIONS)
for v in COLLECTOR_ENDPOINT OTEL_VERSION REPO_URL STORAGE_DIR SERVICE_NAME; do
  if [[ "${!v}" =~ [[:space:][:cntrl:]] ]]; then
    echo "ERROR: ${v} must not contain whitespace or control characters"
    exit 1
  fi
done
[[ "$STORAGE_DIR" == /* ]] || { echo "ERROR: STORAGE_DIR must be an absolute path"; exit 1; }
# No signature or digest check on the package, so the transport must be authenticated
case "$REPO_URL" in
  ""|https://*|file:///*) ;;
  *) echo "ERROR: REPO_URL must be https:// (or file:// for a local mirror); got: ${REPO_URL}"; exit 1 ;;
esac
for v in SYSTEM_LOGS LOG_CAPS; do
  case "${!v}" in
    true|false) ;;
    *) echo "${v} must be true or false (got: ${!v})"; exit 1 ;;
  esac
done
# LOG_PATHS: absolute paths / globs only; /home and /root are hidden from the agent by the sandbox (ProtectHome)
set -f
for lp in $LOG_PATHS; do
  if [[ ! "$lp" =~ ^/[][A-Za-z0-9._/*?-]+$ ]]; then
    echo "ERROR: LOG_PATHS entries must be absolute paths or globs ([A-Za-z0-9._/*?[]-]); got: ${lp}"
    exit 1
  fi
  case "$lp" in
    /home/*|/root/*|/run/user/*)
      echo "ERROR: ${lp} is under /home, /root or /run/user, which the agent sandbox hides (ProtectHome=yes)"
      exit 1 ;;
  esac
done
set +f

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

# Exporter: an http(s):// URL means OTLP/HTTP, host:port means OTLP/gRPC
case "$COLLECTOR_ENDPOINT" in
  https://*) EXPORTER=otlp_http; PLAINTEXT=false ;;
  http://*)  EXPORTER=otlp_http; PLAINTEXT=true ;;
  *://*)     echo "COLLECTOR_ENDPOINT must be host:port (gRPC) or an http:// / https:// URL (got: ${COLLECTOR_ENDPOINT})"; exit 1 ;;
  *)         EXPORTER=otlp_grpc ;;
esac

if [[ "$EXPORTER" == "otlp_grpc" ]]; then
  if [[ -n "${TLS_INSECURE:-}" ]]; then
    INSECURE="$TLS_INSECURE"
  elif [[ -n "$CA_PATH" || -n "$CERT_PATH" ]]; then
    INSECURE=false
  else
    INSECURE=true
  fi
  PLAINTEXT="$INSECURE"
  TLS_YAML="    tls:
      insecure: ${INSECURE}"
else
  # OTLP/HTTP: the URL scheme decides; https:// verifies against the system trust store
  # (company root CA installed via update-ca-trust), TLS_CA_FILE only adds a CA on top
  if [[ "$PLAINTEXT" == "true" && ( -n "$CA_PATH" || -n "$CERT_PATH" ) ]]; then
    echo "ERROR: TLS_CA_FILE / TLS_CERT_FILE given but COLLECTOR_ENDPOINT is http://; use https://"
    exit 1
  fi
  TLS_YAML=""
  [[ -n "$CA_PATH" || -n "$CERT_PATH" ]] && TLS_YAML="    tls:"
fi
if [[ -n "$CA_PATH" ]]; then
  TLS_YAML+=$'\n'"      ca_file: ${CA_PATH}"
fi
if [[ -n "$CERT_PATH" ]]; then
  TLS_YAML+=$'\n'"      cert_file: ${CERT_PATH}"
  TLS_YAML+=$'\n'"      key_file: ${KEY_PATH}"
fi

case "$OTEL_AUTH_SCHEME" in
  Bearer|Basic) ;;
  *) echo "OTEL_AUTH_SCHEME must be Bearer or Basic (got: ${OTEL_AUTH_SCHEME})"; exit 1 ;;
esac
if [[ -n "$OTEL_TOKEN" ]]; then
  if [[ "$OTEL_TOKEN" =~ [[:space:]] ]]; then
    echo "ERROR: OTEL_TOKEN must not contain whitespace"
    exit 1
  fi
  # Catch a wrong Basic token at install time instead of as 401s later
  if [[ "$OTEL_AUTH_SCHEME" == "Basic" ]] && ! base64 -d <<< "$OTEL_TOKEN" 2>/dev/null | grep -q ':'; then
    echo "ERROR: OTEL_AUTH_SCHEME=Basic but OTEL_TOKEN is not base64(\"user:password\")"
    exit 1
  fi
  # Never send credentials in clear text silently
  if [[ "$PLAINTEXT" == "true" ]]; then
    if [[ "${TLS_INSECURE:-}" == "true" ]]; then
      echo "WARNING: OTEL_TOKEN will be sent in CLEAR TEXT and can be captured by anyone on the network. Trusted networks / labs only."
    else
      echo "ERROR: OTEL_TOKEN is set but the connection is clear text, so the token would be sent unencrypted."
      echo "  Use an https:// endpoint (OTLP/HTTP) or TLS_CA_FILE (gRPC), or set TLS_INSECURE=true explicitly to accept the risk."
      exit 1
    fi
  fi
fi

HEADERS_YAML=""
if [[ -n "$OTEL_TOKEN" ]]; then
  HEADERS_YAML=$'\n'"    headers:"$'\n'"      authorization: \"${OTEL_AUTH_SCHEME} \${env:OTEL_TOKEN}\""
fi

# Host attributes -> OTEL_RESOURCE_ATTRIBUTES (read by the env resource detector)
if [[ -n "$HOST_ATTRIBUTES" ]]; then
  IFS=',' read -r -a HOST_ATTR_LIST <<< "$HOST_ATTRIBUTES"
  for kv in "${HOST_ATTR_LIST[@]}"; do
    if [[ ! "$kv" =~ ^[A-Za-z][A-Za-z0-9._-]*=[A-Za-z0-9._/:-]+$ ]]; then
      echo "ERROR: HOST_ATTRIBUTES entries must be key=value (key [A-Za-z0-9._-], value [A-Za-z0-9._/:-]); got: ${kv}"
      exit 1
    fi
    case "${kv%%=*}" in
      service.name|service.instance.id)
        echo "ERROR: ${kv%%=*} cannot be set in HOST_ATTRIBUTES (use SERVICE_NAME; service.instance.id is the host name)"
        exit 1 ;;
    esac
  done
fi

# Build file_log include list YAML
FILELOG_INCLUDE=""
set -f  # do not expand LOG_PATHS globs at install time; file_log matches them at runtime
for p in $LOG_PATHS; do
  FILELOG_INCLUDE+=$'\n'"      - ${p}"
done
set +f

if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "SERVICE_NAME may only contain letters, digits and . _ - (got: ${SERVICE_NAME})"
  exit 1
fi
case "$ENABLE_PROCESS_METRICS" in
  true|false) ;;
  *) echo "ENABLE_PROCESS_METRICS must be true or false (got: ${ENABLE_PROCESS_METRICS})"; exit 1 ;;
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
        # The agent runs without capabilities: other users' /proc/<pid>/{exe,io} give EACCES, mute those errors.
        # process.disk.io is not collected: it needs CAP_SYS_PTRACE, which would let the agent read any process's memory.
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
          # on by default in host_metrics; switch it off explicitly (see above)
          process.disk.io:
            enabled: false"
else
  PROCESS_SCRAPER=""
fi

# Package source, first match wins: a local file (RPM_PATH), the internal repo (REPO_URL), the GitHub release.
# Packages are built and published by internal teams, so no separate digest check is done here.
if [[ -z "${RPM_PATH:-}" && -n "$REPO_URL" ]]; then
  # Use the repo for this run only: no .repo file is written, metadata is cached in the private WORKDIR
  command -v dnf >/dev/null 2>&1 || { echo "REPO_URL needs dnf"; exit 1; }
  echo "Installing otelcol-contrib-${OTEL_VERSION} from ${REPO_URL}"
  dnf install -y --repofrompath="otel-internal,${REPO_URL}" --repo=otel-internal \
    --setopt=otel-internal.gpgcheck=0 --setopt=cachedir="${WORKDIR}/dnf-cache" "otelcol-contrib-${OTEL_VERSION}"
else
  if [[ -n "${RPM_PATH:-}" ]]; then
    [[ -f "$RPM_PATH" ]] || { echo "RPM_PATH not found: $RPM_PATH"; exit 1; }
    RPM_FILE="$RPM_PATH"
  else
    # Download into the private WORKDIR, never a predictable path another user could pre-fill
    RPM_FILE="${WORKDIR}/${RPM_NAME}"
    echo "Downloading $RPM_URL ..."
    curl -fL --proto '=https' --proto-redir '=https' --retry 3 -o "$RPM_FILE" "$RPM_URL"
  fi
  echo "Installing RPM: $RPM_FILE"
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y "$RPM_FILE"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "$RPM_FILE"
  else
    rpm -ivh "$RPM_FILE"
  fi
fi

if id otelcol-contrib >/dev/null 2>&1; then
  if [[ -d "$CERTS_DIR" ]]; then
    chown -R root:otelcol-contrib "$CERTS_DIR" || true
    chmod 0750 "$CERTS_DIR" || true
    [[ -n "$CA_PATH" ]] && chmod 0640 "$CA_PATH" || true
    [[ -n "$CERT_PATH" ]] && chmod 0640 "$CERT_PATH" || true
    [[ -n "$KEY_PATH" ]] && chmod 0640 "$KEY_PATH" || true
  fi
  # Older versions of this script added the agent to adm; it is not needed (journald access comes from
  # SupplementaryGroups in the unit drop-in), so take it back
  if id -nG otelcol-contrib | tr ' ' '\n' | grep -qx adm; then
    gpasswd -d otelcol-contrib adm >/dev/null && echo "Removed otelcol-contrib from the adm group (no longer needed)"
  fi
fi

CONFIG=/etc/otelcol-contrib/config.yaml
CONF=/etc/otelcol-contrib/otelcol-contrib.conf
BACKUP_SUFFIX="$(date +%Y%m%d%H%M%S)"
[[ -f "$CONFIG" ]] && cp -a "$CONFIG" "${CONFIG}.bak.${BACKUP_SUFFIX}"

# Logs: system logs from journald (SYSTEM_LOGS) and/or application log files (LOG_PATHS); both optional
LOG_RECEIVERS=()
JOURNALD_RECEIVER=""
FILELOG_RECEIVER=""
JOURNALD_PROCESSORS_YAML=""
JOURNALD_PROCESSOR=""
if [[ "$SYSTEM_LOGS" == "true" ]]; then
  LOG_RECEIVERS+=(journald)
  # journal access comes from SupplementaryGroups=systemd-journal in the unit drop-in
  JOURNALD_RECEIVER="
  journald:
    priority: info
    start_at: end
    # cursor persisted: after an agent/host restart, resume where it stopped
    storage: file_storage"
  # journald records arrive as a map of all journal fields: keep MESSAGE as the body, map PRIORITY to
  # severity, keep unit + identifier (structured metadata in Loki, not index labels), drop the rest
  JOURNALD_PROCESSORS_YAML='
  transform/journald:
    error_mode: ignore
    log_statements:
      - context: log
        conditions:
          - IsMap(log.body) and log.body["MESSAGE"] != nil
        statements:
          - set(log.attributes["systemd.unit"], log.body["_SYSTEMD_UNIT"]) where log.body["_SYSTEMD_UNIT"] != nil
          - set(log.attributes["syslog.identifier"], log.body["SYSLOG_IDENTIFIER"]) where log.body["SYSLOG_IDENTIFIER"] != nil
          - set(log.severity_number, SEVERITY_NUMBER_FATAL) where log.body["PRIORITY"] == "0" or log.body["PRIORITY"] == "1" or log.body["PRIORITY"] == "2"
          - set(log.severity_number, SEVERITY_NUMBER_ERROR) where log.body["PRIORITY"] == "3"
          - set(log.severity_number, SEVERITY_NUMBER_WARN) where log.body["PRIORITY"] == "4"
          - set(log.severity_number, SEVERITY_NUMBER_INFO2) where log.body["PRIORITY"] == "5"
          - set(log.severity_number, SEVERITY_NUMBER_INFO) where log.body["PRIORITY"] == "6"
          - set(log.severity_text, "fatal") where log.severity_number == SEVERITY_NUMBER_FATAL
          - set(log.severity_text, "error") where log.severity_number == SEVERITY_NUMBER_ERROR
          - set(log.severity_text, "warn") where log.severity_number == SEVERITY_NUMBER_WARN
          - set(log.severity_text, "info") where log.severity_number == SEVERITY_NUMBER_INFO or log.severity_number == SEVERITY_NUMBER_INFO2
          - set(log.body, log.body["MESSAGE"])'
  JOURNALD_PROCESSOR="transform/journald, "
fi
if [[ -n "$LOG_PATHS" ]]; then
  LOG_RECEIVERS+=(file_log)
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
    include_file_name: true"
fi
if [[ "${#LOG_RECEIVERS[@]}" -gt 0 ]]; then
  LOG_RECEIVER_LIST="$(IFS=,; echo "${LOG_RECEIVERS[*]}" | sed 's/,/, /g')"
  LOGS_PIPELINE="
    logs:
      receivers: [${LOG_RECEIVER_LIST}]
      processors: [memory_limiter, ${JOURNALD_PROCESSOR}resource/service, resource_detection, transform/instance_id, batch]
      exporters: [${EXPORTER}]
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
          - {action: aggregate_labels, label_set: [state], aggregation_type: sum}'
  PROCESS_PROCESSOR_LIST="transform/process_identity, groupbyattrs/processes, metrics_transform/sum_processes, "
else
  PROCESS_PROCESSORS_YAML=""
  PROCESS_PROCESSOR_LIST=""
fi

cat > "$CONFIG" << YAML
# otelcol-contrib host agent: host metrics + optional journald / file logs
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
      processes:${PROCESS_SCRAPER}${JOURNALD_RECEIVER}${FILELOG_RECEIVER}

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 256
    spike_limit_mib: 64${PROCESS_PROCESSORS_YAML}${JOURNALD_PROCESSORS_YAML}
  resource/service:
    attributes:
      - key: service.name
        value: ${SERVICE_NAME}
        action: insert
  # env first: HOST_ATTRIBUTES (OTEL_RESOURCE_ATTRIBUTES) win over detected values
  resource_detection:
    detectors: [env, system]
    system:
      hostname_sources: [os]
      resource_attributes:
        host.id: {enabled: true}
        host.arch: {enabled: true}
        os.description: {enabled: true}
  # service.instance.id becomes the "instance" label in Mimir/Prometheus: without it every host
  # with the same service.name would write into the same series
  transform/instance_id:
    error_mode: ignore
    metric_statements:
      - context: resource
        statements:
          - set(resource.attributes["service.instance.id"], resource.attributes["host.name"]) where resource.attributes["service.instance.id"] == nil
    log_statements:
      - context: resource
        statements:
          - set(resource.attributes["service.instance.id"], resource.attributes["host.name"]) where resource.attributes["service.instance.id"] == nil
  batch:
    send_batch_size: 1024
    timeout: 10s

exporters:
  ${EXPORTER}:
    endpoint: \${env:COLLECTOR_ENDPOINT}
${TLS_YAML}${HEADERS_YAML}

service:${SERVICE_EXTENSIONS}
  pipelines:
    metrics:
      receivers: [host_metrics]
      processors: [memory_limiter, ${PROCESS_PROCESSOR_LIST}resource/service, resource_detection, transform/instance_id, batch]
      exporters: [${EXPORTER}]
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
  if [[ -n "$HOST_ATTRIBUTES" ]]; then
    echo "OTEL_RESOURCE_ATTRIBUTES=${HOST_ATTRIBUTES}"
  fi
} > "$CONF"
chmod 0640 "$CONF" || true
if id otelcol-contrib >/dev/null 2>&1; then
  chown root:otelcol-contrib "$CONF" || true
fi

echo
echo "Transport: ${EXPORTER} -> ${COLLECTOR_ENDPOINT} ($([[ "$PLAINTEXT" == "true" ]] && echo "clear text" || echo "TLS"))"
[[ -n "$CA_PATH" ]] && echo "  ca_file=${CA_PATH}"
[[ -n "$CERT_PATH" ]] && echo "  cert_file=${CERT_PATH} key_file=${KEY_PATH}"
[[ -n "$OTEL_TOKEN" ]] && echo "  headers.authorization=${OTEL_AUTH_SCHEME} \${OTEL_TOKEN} (from ${CONF})"
echo "service.name=${SERVICE_NAME}  service.instance.id=<host.name>  host attributes: ${HOST_ATTRIBUTES:-none}"
echo "System logs (journald, priority info+): $([[ "$SYSTEM_LOGS" == "true" ]] && echo on || echo off)"
echo "Application log files (file_log): ${LOG_PATHS:-none}$([[ "$LOG_CAPS" == "true" ]] && echo "  [LOG_CAPS=true: CAP_DAC_READ_SEARCH granted, the agent can read ANY file]")"
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

if [[ "${#LOG_RECEIVERS[@]}" -gt 0 ]]; then
  install -d -m 0750 "$STORAGE_DIR"
  chown otelcol-contrib:otelcol-contrib "$STORAGE_DIR" 2>/dev/null || true
fi

# Application log files the agent cannot read are skipped silently by file_log: say so now
if [[ -n "$LOG_PATHS" && "$LOG_CAPS" != "true" ]]; then
  UNREADABLE=()
  for lp in $LOG_PATHS; do
    for f in $lp; do
      if [[ -f "$f" ]] && ! runuser -u otelcol-contrib -- test -r "$f"; then
        UNREADABLE+=("$f")
      fi
    done
  done
  if [[ "${#UNREADABLE[@]}" -gt 0 ]]; then
    echo "WARNING: the agent (user otelcol-contrib) cannot read: ${UNREADABLE[*]}"
    echo "  Make them readable for it (group / ACL set by the application owner), or set LOG_CAPS=true as a stopgap."
  fi
fi

# Keep only the 5 newest backups (conf backups contain OTEL_TOKEN and must not pile up)
for f in "$CONFIG" "$CONF"; do
  ls -1t "${f}".bak.* 2>/dev/null | tail -n +6 | xargs -r rm -f --
done

# Validate the new config first; on failure restore the old one, so a running agent is never switched to a config that cannot start
# Variables are passed as prefix assignments (not in argv), so the token does not show up in ps
if ! COLLECTOR_ENDPOINT="$COLLECTOR_ENDPOINT" KEEP_PROCESS_PIDS="$KEEP_PROCESS_PIDS" OTEL_TOKEN="$OTEL_TOKEN" OTEL_RESOURCE_ATTRIBUTES="$HOST_ATTRIBUTES" \
    runuser -u otelcol-contrib -- /usr/bin/otelcol-contrib validate --config="$CONFIG"; then
  echo "ERROR: the generated config failed otelcol-contrib validate; the previous config was restored and the agent was not restarted."
  if [[ -f "${CONFIG}.bak.${BACKUP_SUFFIX}" ]]; then
    cp -a "${CONFIG}.bak.${BACKUP_SUFFIX}" "$CONFIG"
    [[ -f "${CONF}.bak.${BACKUP_SUFFIX}" ]] && cp -a "${CONF}.bak.${BACKUP_SUFFIX}" "$CONF"
  fi
  exit 1
fi

# OTLP/HTTP preflight: send an empty export with the same CA store and credentials before switching
# config, so a wrong token or a missing company CA fails the install instead of silently dropping data.
# --noproxy: the systemd service does not inherit the login shell's proxy variables either.
if [[ "$EXPORTER" == "otlp_http" ]]; then
  PREFLIGHT_ARGS=(-sS -o /dev/null -w '%{http_code}' --max-time 15 --noproxy '*' -X POST
    -H 'Content-Type: application/json' --data '{}')
  [[ -n "$CA_PATH" ]] && PREFLIGHT_ARGS+=(--cacert "$CA_PATH")
  [[ -n "$CERT_PATH" ]] && PREFLIGHT_ARGS+=(--cert "$CERT_PATH" --key "$KEY_PATH")
  # header passed on stdin so the token never appears in argv
  PREFLIGHT_CODE="$(printf 'Authorization: %s %s\n' "$OTEL_AUTH_SCHEME" "$OTEL_TOKEN" \
    | curl "${PREFLIGHT_ARGS[@]}" $([[ -n "$OTEL_TOKEN" ]] && echo "-H @-") "${COLLECTOR_ENDPOINT%/}/v1/metrics" 2>"${WORKDIR}/preflight.err")" || true
  if [[ "$PREFLIGHT_CODE" != 2* ]]; then
    echo "ERROR: preflight POST ${COLLECTOR_ENDPOINT%/}/v1/metrics failed (HTTP ${PREFLIGHT_CODE:-none}): $(head -c 200 "${WORKDIR}/preflight.err")"
    echo "  401/403 = wrong OTEL_TOKEN; certificate errors = company CA missing from the system trust store (update-ca-trust)."
    echo "  The previous config was restored and the agent was not restarted."
    rm -f "${WORKDIR}/preflight.err"
    if [[ -f "${CONFIG}.bak.${BACKUP_SUFFIX}" ]]; then
      cp -a "${CONFIG}.bak.${BACKUP_SUFFIX}" "$CONFIG"
      [[ -f "${CONF}.bak.${BACKUP_SUFFIX}" ]] && cp -a "${CONF}.bak.${BACKUP_SUFFIX}" "$CONF"
    fi
    exit 1
  fi
  rm -f "${WORKDIR}/preflight.err"
  echo "Preflight to ${COLLECTOR_ENDPOINT}: HTTP ${PREFLIGHT_CODE}"
fi

# One managed drop-in: least privilege + sandbox. Written only after validate/preflight passed.
DROPIN_DIR=/etc/systemd/system/otelcol-contrib.service.d
DROPIN="${DROPIN_DIR}/10-otelcol-agent.conf"
rm -f "${DROPIN_DIR}/10-process-metrics.conf" "${DROPIN_DIR}/10-read-logs.conf"   # written by older versions
CAPS=""
[[ "$LOG_CAPS" == "true" ]] && CAPS="CAP_DAC_READ_SEARCH"
install -d -m 0755 "$DROPIN_DIR"
{
  echo "# Managed by centos-install.sh: least privilege + sandbox for the host agent"
  echo "[Service]"
  echo "# Empty = no capabilities at all (LOG_CAPS=true adds CAP_DAC_READ_SEARCH)"
  echo "CapabilityBoundingSet=${CAPS}"
  echo "AmbientCapabilities=${CAPS}"
  [[ "$SYSTEM_LOGS" == "true" ]] && echo "SupplementaryGroups=systemd-journal"
  echo "NoNewPrivileges=yes"
  echo "ProtectSystem=strict"
  echo "ReadWritePaths=-${STORAGE_DIR}"
  echo "ProtectHome=yes"
  echo "PrivateTmp=yes"
  echo "# Secrets the agent never needs. /etc/shadow cannot be listed: SELinux forbids mounting over shadow_t;"
  echo "# without capabilities its 0000 mode already keeps it unreadable."
  echo "InaccessiblePaths=-/etc/ssh -/etc/sudoers -/etc/sudoers.d -/etc/pki/tls/private"
  echo "ProtectKernelTunables=yes"
  echo "ProtectKernelModules=yes"
  echo "ProtectControlGroups=yes"
  echo "RestrictSUIDSGID=yes"
  echo "RestrictNamespaces=yes"
  echo "LockPersonality=yes"
  echo "SystemCallArchitectures=native"
} > "$DROPIN"
echo "systemd drop-in: ${DROPIN} (capabilities: ${CAPS:-none})"

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
