#!/usr/bin/env bash
# RHEL and RHEL-compatible distributions: install otelcol-contrib as a host agent shipping host metrics and,
# optionally, journald / application logs to a central collector over OTLP/HTTP. The agent runs without
# capabilities in a systemd sandbox. Config = the static fragments in ./agent + per-host values in the
# EnvironmentFile written here.
#
#   read -rs OTEL_TOKEN && export OTEL_TOKEN          # not echoed, not in shell history
#   sudo -E COLLECTOR_ENDPOINT=https://otel-gw.example:4318 bash redhat-install.sh
# sudo logs its command line to the journal (shipped by this agent!) and also the variables given with
# --preserve-env=...; with -E the environment is not logged. Never put the token on the sudo command line.
#
# Variables:
#   COLLECTOR_ENDPOINT   required; https://host:port (http:// only without a token)
#   OTEL_TOKEN           Basic auth token, base64("user:password"); requires https:// (checked by the preflight)
#   REPO_URL             internal yum repo (https:// or file://); default: GitHub release download
#   OTEL_VERSION         default 0.164.0
#   HOST_ATTRIBUTES      "deployment.environment.name=prod,datacenter=sh1,team=infra"
#   SERVICE_NAME         default redhat-host
#   PROCESS_NAMES        "sshd nginx" (exact names, space/comma-separated); unset = no per-process metrics
#   KEEP_PROCESS_PIDS    default false; true = one series per pid instead of per name+owner (debugging)
#   SYSTEM_LOGS          default true; journald, priority info and above
#   LOG_PATHS            "/var/log/myapp/*.log" application log files; unset = none
set -euo pipefail

COLLECTOR_ENDPOINT="${COLLECTOR_ENDPOINT:-}"
OTEL_TOKEN="${OTEL_TOKEN:-}"
REPO_URL="${REPO_URL:-}"
OTEL_VERSION="${OTEL_VERSION:-0.164.0}"
HOST_ATTRIBUTES="${HOST_ATTRIBUTES:-}"
SERVICE_NAME="${SERVICE_NAME:-redhat-host}"
PROCESS_NAMES="${PROCESS_NAMES:-}"
KEEP_PROCESS_PIDS="${KEEP_PROCESS_PIDS:-false}"
SYSTEM_LOGS="${SYSTEM_LOGS:-true}"
LOG_PATHS="${LOG_PATHS:-}"

SRC="$(cd "$(dirname "$0")" && pwd)/agent"
ETC=/etc/otelcol-contrib
CONF="${ETC}/otelcol-contrib.conf"
STORAGE_DIR=/var/lib/otelcol-contrib/file_storage
DROPIN=/etc/systemd/system/otelcol-contrib.service.d/10-otelcol-agent.conf

die() { echo "ERROR: $*" >&2; exit 1; }

[[ "$EUID" -eq 0 ]] || die "run as root"
[[ -d "$SRC" ]] || die "config fragments not found in ${SRC}"

# ---------- inputs (values end up in a systemd EnvironmentFile: no whitespace, quotes or control chars)
for v in COLLECTOR_ENDPOINT OTEL_TOKEN REPO_URL OTEL_VERSION SERVICE_NAME HOST_ATTRIBUTES; do
  [[ ! "${!v}" =~ [[:space:][:cntrl:]\'\"] ]] || die "${v} must not contain whitespace, quotes or control characters"
done
case "$COLLECTOR_ENDPOINT" in
  https://*) ;;
  http://*) [[ -z "$OTEL_TOKEN" ]] || die "OTEL_TOKEN requires an https:// COLLECTOR_ENDPOINT" ;;
  *) die "COLLECTOR_ENDPOINT must be https://host:port (got: '${COLLECTOR_ENDPOINT}')" ;;
esac
# No signature or digest check on the package, so its transport must be authenticated
case "$REPO_URL" in ""|https://*|file:///*) ;; *) die "REPO_URL must be https:// or file://" ;; esac
for v in KEEP_PROCESS_PIDS SYSTEM_LOGS; do
  case "${!v}" in true|false) ;; *) die "${v} must be true or false" ;; esac
done

kv='[A-Za-z][A-Za-z0-9._-]*=[A-Za-z0-9._/:-]+'
[[ -z "$HOST_ATTRIBUTES" || "$HOST_ATTRIBUTES" =~ ^${kv}(,${kv})*$ ]] || die "HOST_ATTRIBUTES must be key=value,key=value"

# Lists are passed to the collector as JSON arrays (parsed as YAML lists by ${env:...})
to_json() { local out="" x; for x in "$@"; do out+="${out:+,}\"${x}\""; done; echo "[${out}]"; }
names=()
read -r -a names <<< "${PROCESS_NAMES//,/ }"
for n in "${names[@]}"; do
  [[ "$n" =~ ^[A-Za-z0-9._+-]{1,15}$ ]] || die "PROCESS_NAMES entry '${n}' is not a process name (comm, max 15 chars)"
done
paths=()
set -f   # globs are matched by the collector at runtime, not expanded here
read -r -a paths <<< "$LOG_PATHS"
for p in "${paths[@]}"; do
  [[ "$p" =~ ^/[][A-Za-z0-9._/*?-]+$ ]] || die "LOG_PATHS entry '${p}' must be an absolute path or glob"
  case "$p" in /home/*|/root/*|/run/user/*) die "${p} is hidden from the agent by its sandbox (ProtectHome)" ;; esac
done
set +f

# ---------- package
WORK="$(mktemp -d /tmp/otelcol-install.XXXXXXXX)"   # unpredictable, root-only: nobody can pre-place an RPM
trap 'rm -rf "$WORK"' EXIT
if [[ -n "$REPO_URL" ]]; then
  # repo used for this run only: no .repo file; RPMs are unsigned, so gpgcheck is off and https is required above
  dnf install -y --repofrompath="otel-internal,${REPO_URL}" --repo=otel-internal \
    --setopt=otel-internal.gpgcheck=0 --setopt=cachedir="${WORK}/dnf" "otelcol-contrib-${OTEL_VERSION}"
else
  case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac
  rpm="otelcol-contrib_${OTEL_VERSION}_linux_${arch}.rpm"
  curl -fL --proto '=https' --proto-redir '=https' --retry 3 -o "${WORK}/${rpm}" \
    "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTEL_VERSION}/${rpm}"
  dnf install -y "${WORK}/${rpm}"
fi

# ---------- stage config + environment, validate and preflight before touching the running agent
STAGE="${WORK}/etc"
install -d -m 0750 -g otelcol-contrib "$WORK" "$STAGE"   # the validate step runs as the agent user
fragments=(agent.yaml)
[[ -n "$OTEL_TOKEN" ]] && fragments+=(auth.yaml)
[[ "${#names[@]}" -gt 0 ]] && fragments+=(processes.yaml)
[[ "$SYSTEM_LOGS" == "true" ]] && fragments+=(logs-journald.yaml)
[[ "${#paths[@]}" -gt 0 ]] && fragments+=(logs-files.yaml)
opts=""
for f in "${fragments[@]}"; do
  install -m 0644 "${SRC}/${f}" "${STAGE}/${f}"
  opts+="${opts:+ }--config=${ETC}/${f}"
done

PROCESS_NAMES_JSON="$(to_json "${names[@]}")"
set -f; LOG_PATHS_JSON="$(to_json "${paths[@]}")"; set +f
{
  echo "# Managed by redhat-install.sh"
  echo "OTELCOL_OPTIONS=\"${opts}\""
  echo "COLLECTOR_ENDPOINT=${COLLECTOR_ENDPOINT}"
  echo "SERVICE_NAME=${SERVICE_NAME}"
  echo "KEEP_PROCESS_PIDS=${KEEP_PROCESS_PIDS}"
  echo "PROCESS_NAMES='${PROCESS_NAMES_JSON}'"
  echo "LOG_PATHS='${LOG_PATHS_JSON}'"
  [[ -z "$HOST_ATTRIBUTES" ]] || echo "OTEL_RESOURCE_ATTRIBUTES=${HOST_ATTRIBUTES}"
  [[ -z "$OTEL_TOKEN" ]] || echo "OTEL_TOKEN=${OTEL_TOKEN}"
} > "${STAGE}/otelcol-contrib.conf"
chgrp otelcol-contrib "${STAGE}/otelcol-contrib.conf"
chmod 0640 "${STAGE}/otelcol-contrib.conf"

# Variables passed as prefix assignments, so the token is not in argv
COLLECTOR_ENDPOINT="$COLLECTOR_ENDPOINT" SERVICE_NAME="$SERVICE_NAME" KEEP_PROCESS_PIDS="$KEEP_PROCESS_PIDS" \
  PROCESS_NAMES="$PROCESS_NAMES_JSON" LOG_PATHS="$LOG_PATHS_JSON" OTEL_TOKEN="$OTEL_TOKEN" \
  OTEL_RESOURCE_ATTRIBUTES="$HOST_ATTRIBUTES" \
  runuser -u otelcol-contrib -- /usr/bin/otelcol-contrib validate ${opts//${ETC}/${STAGE}} \
  || die "generated config failed otelcol-contrib validate; the running agent was not changed"

# Empty OTLP export with the same CA store (system trust) and credentials; --noproxy like the systemd service.
# The auth header goes through stdin, so the token is not in argv.
auth=()
[[ -z "$OTEL_TOKEN" ]] || auth=(-H @-)
code="$(printf 'Authorization: Basic %s\n' "$OTEL_TOKEN" | curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
  --noproxy '*' -X POST -H 'Content-Type: application/json' --data '{}' "${auth[@]}" \
  "${COLLECTOR_ENDPOINT%/}/v1/metrics" 2>"${WORK}/preflight.err")" || true
[[ "$code" == 2* ]] || die "preflight to ${COLLECTOR_ENDPOINT} failed (HTTP ${code:-none}): $(head -c 200 "${WORK}/preflight.err")
  401 = wrong OTEL_TOKEN; certificate error = company CA missing from the system trust store. The running agent was not changed."

# ---------- install: config, environment, sandbox drop-in
rm -f "${ETC}"/*.yaml "${ETC}"/*.rpmsave "${ETC}"/*.rpmnew   # rpm leftovers may hold an old token
cp -p "${STAGE}"/*.yaml "${STAGE}/otelcol-contrib.conf" "$ETC/"
install -d -m 0750 -o otelcol-contrib -g otelcol-contrib "$STORAGE_DIR"
install -d -m 0755 "$(dirname "$DROPIN")"
journal_group=""
[[ "$SYSTEM_LOGS" != "true" ]] || journal_group="SupplementaryGroups=systemd-journal"
cat > "$DROPIN" << UNIT
# Managed by redhat-install.sh. No capabilities: file permissions already keep the agent user away from
# secrets (shadow, SSH keys, other processes' memory). The rest limits privilege escalation and kernel
# attack surface (setuid binaries, user namespaces) and keeps writes to the storage directory.
[Service]
CapabilityBoundingSet=
${journal_group}
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=${STORAGE_DIR}
ProtectHome=yes
PrivateTmp=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
UNIT

# Application log files the agent cannot read are skipped silently by file_log: say so now
for p in "${paths[@]}"; do
  for f in $p; do
    if [[ -f "$f" ]] && ! runuser -u otelcol-contrib -- test -r "$f"; then
      echo "WARNING: user otelcol-contrib cannot read ${f}; the application owner must make it readable (group or ACL)"
    fi
  done
done

systemctl daemon-reload
systemctl enable otelcol-contrib
systemctl restart otelcol-contrib
# Type=simple + Restart=on-failure: restart always "succeeds", so check the process stays up
sleep 8
if [[ "$(systemctl show -p ActiveState --value otelcol-contrib)" != "active" \
   || "$(systemctl show -p NRestarts --value otelcol-contrib)" != "0" ]]; then
  journalctl -u otelcol-contrib -n 20 --no-pager || true
  die "otelcol-contrib did not stay up"
fi
echo "otelcol-contrib running: ${fragments[*]} -> ${COLLECTOR_ENDPOINT}"
