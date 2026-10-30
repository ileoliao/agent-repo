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
#   TLS_CA_FILE=/path/ca.crt
#   TLS_CERT_FILE=/path/client.crt
#   TLS_KEY_FILE=/path/client.key
#   OTEL_TOKEN=...
#   TLS_INSECURE=true|false
#   LOG_PATHS="/var/log/messages /var/log/secure"   # file_log 采集路径，空格分隔
#   ENABLE_LOGS=true|false                          # 默认 true
#   KEEP_PROCESS_PIDS=true|false                    # 默认 false: 导出前删除 process.pid / process.parent_pid（基数）；仅调试时设 true
set -euo pipefail

OTEL_VERSION="${OTEL_VERSION:-0.164.0}"
COLLECTOR_ENDPOINT="${COLLECTOR_ENDPOINT:-REPLACE_ME:4317}"
TLS_CA_FILE="${TLS_CA_FILE:-}"
TLS_CERT_FILE="${TLS_CERT_FILE:-}"
TLS_KEY_FILE="${TLS_KEY_FILE:-}"
OTEL_TOKEN="${OTEL_TOKEN:-}"
CERTS_DIR="${CERTS_DIR:-/etc/otelcol-contrib/certs}"
ENABLE_LOGS="${ENABLE_LOGS:-true}"
# CentOS/RHEL 常见系统日志；可用 LOG_PATHS 覆盖
LOG_PATHS="${LOG_PATHS:-/var/log/messages /var/log/secure}"
KEEP_PROCESS_PIDS="${KEEP_PROCESS_PIDS:-false}"
case "$KEEP_PROCESS_PIDS" in
  true|false) ;;
  *) echo "KEEP_PROCESS_PIDS 只能是 true 或 false (当前: $KEEP_PROCESS_PIDS)"; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) RPM_ARCH=amd64 ;;
  aarch64|arm64) RPM_ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac

RPM_NAME="otelcol-contrib_${OTEL_VERSION}_linux_${RPM_ARCH}.rpm"
RPM_URL="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_VERSION}/${RPM_NAME}"
WORKDIR="${WORKDIR:-/tmp/otelcol-install}"
mkdir -p "$WORKDIR"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 或 sudo 跑这个脚本"
  exit 1
fi

install_secret_file() {
  local src="$1" dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "找不到文件: $src"
    exit 1
  fi
  install -d -m 0755 "$(dirname "$dest")"
  install -m 0640 -o root -g otelcol-contrib "$src" "$dest" 2>/dev/null \
    || install -m 0640 "$src" "$dest"
}

if [[ -n "$TLS_CERT_FILE" && -z "$TLS_KEY_FILE" ]] || [[ -z "$TLS_CERT_FILE" && -n "$TLS_KEY_FILE" ]]; then
  echo "TLS_CERT_FILE 和 TLS_KEY_FILE 必须成对提供"
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
set -f  # 不要在安装时展开 LOG_PATHS 里的通配符，交给 file_log 运行时匹配
for p in $LOG_PATHS; do
  FILELOG_INCLUDE+=$'\n'"      - ${p}"
done
set +f

if [[ -n "${RPM_PATH:-}" ]]; then
  RPM_FILE="$RPM_PATH"
else
  RPM_FILE="${WORKDIR}/${RPM_NAME}"
  if [[ ! -f "$RPM_FILE" ]]; then
    echo "下载 $RPM_URL ..."
    curl -fL --retry 3 -o "$RPM_FILE" "$RPM_URL"
  fi
fi

echo "安装 RPM: $RPM_FILE"
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
  # 读 /var/log/messages、secure 通常需要 adm 组
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
    include_file_path: true
    include_file_name: true
"
  LOGS_PIPELINE="
    logs:
      receivers: [file_log]
      processors: [resource_detection, batch]
      exporters: [otlp_grpc]
"
else
  FILELOG_RECEIVER=""
  LOGS_PIPELINE=""
fi

cat > "$CONFIG" << YAML
# otelcol-contrib host agent — OS metrics + optional file logs
# Generated by centos-install.sh (otelcol-contrib ${OTEL_VERSION})
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
      process:
        mute_process_name_error: true
        mute_process_exe_error: true
        mute_process_io_error: true
        mute_process_user_error: true
        mute_process_cgroup_error: true
${FILELOG_RECEIVER}
processors:
  # Drop per-process PID resource attributes (high cardinality). Set KEEP_PROCESS_PIDS=true to keep them for debugging.
  transform/drop_process_pids:
    error_mode: ignore
    metric_statements:
      - context: resource
        statements:
          - 'delete_key(resource.attributes, "process.pid") where "\${env:KEEP_PROCESS_PIDS:-false}" != "true"'
          - 'delete_key(resource.attributes, "process.parent_pid") where "\${env:KEEP_PROCESS_PIDS:-false}" != "true"'
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

service:
  pipelines:
    metrics:
      receivers: [host_metrics]
      processors: [transform/drop_process_pids, resource_detection, batch]
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
echo "认证配置:"
echo "  tls.insecure=${INSECURE}"
[[ -n "$CA_PATH" ]] && echo "  ca_file=${CA_PATH}"
[[ -n "$CERT_PATH" ]] && echo "  cert_file=${CERT_PATH} key_file=${KEY_PATH}"
[[ -n "$OTEL_TOKEN" ]] && echo "  headers.authorization=Bearer \${OTEL_TOKEN} (在 ${CONF})"
if [[ "$KEEP_PROCESS_PIDS" == "true" ]]; then
  echo "进程指标: 保留 process.pid / process.parent_pid (KEEP_PROCESS_PIDS=true, 仅用于调试)"
else
  echo "进程指标: 已删除 process.pid / process.parent_pid (默认, 避免高基数)"
fi
if [[ "${ENABLE_LOGS}" == "true" ]]; then
  echo "日志采集路径 (file_log): ${LOG_PATHS}"
else
  echo "日志采集: 已关闭 (ENABLE_LOGS=false)"
fi

# CentOS/RHEL 的 /var/log/messages、secure 默认是 root:root 0600，adm 组读不了；
# 用 CAP_DAC_READ_SEARCH（只读绕过权限检查）比改成 root 运行或 chmod 日志更稳，logrotate 重建文件后依然有效。
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

if [[ "$COLLECTOR_ENDPOINT" == "REPLACE_ME:4317" ]]; then
  echo "警告: COLLECTOR_ENDPOINT 还是占位符，请改 ${CONF} 后再启动"
  echo "示例: COLLECTOR_ENDPOINT=10.0.0.20:4317"
  systemctl daemon-reload
  systemctl enable otelcol-contrib
  echo "已 enable，未 start。改好 endpoint 后执行: systemctl start otelcol-contrib"
  exit 0
fi

systemctl daemon-reload
systemctl enable otelcol-contrib
systemctl restart otelcol-contrib
systemctl --no-pager --full status otelcol-contrib || true
echo
echo "看日志: journalctl -u otelcol-contrib -f"
echo "配置:   $CONFIG"
echo "环境:   $CONF  (COLLECTOR_ENDPOINT=$COLLECTOR_ENDPOINT)"
