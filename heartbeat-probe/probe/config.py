"""Configuration: one YAML file is the single source of truth.

The same file drives the probe at runtime and `render.py` (Grafana rules,
GCP log metrics, alert policies and SLOs), so thresholds never drift apart.
Secrets are never written in the file: fields ending in `_env` name an
environment variable that holds the value.
"""

from __future__ import annotations

import os
import socket
import urllib.parse
from dataclasses import dataclass, field

import yaml

# promise name -> (kind, signal)
PROMISE_TYPES = {
    "metrics_alert": ("alert", "metrics"),
    "logs_alert": ("alert", "logs"),
    "logs_query": ("query", "logs"),
    "traces_query": ("query", "traces"),
}

PROMISE_DEFAULTS = {
    # common
    "enabled": True,
    "tenants": None,                 # None = all tenants
    "deadline_seconds": 300,         # result must arrive within this time
    "latency_objective_seconds": 120,  # GCP "slow" alert threshold (p95)
    "absent_for_seconds": 900,       # GCP "broken" alert: no success for this long
    "slo_target": 0.999,             # GCP SLO: share of checks that succeed
    "slo_window_days": 28,
    # alert loops
    "firing_seconds": 120,           # metrics: how long the gauge stays 1; logs: rule lookback window
    # query checks
    "count": 10,                     # log lines / spans written per check
    "poll_interval_seconds": 5,
    "query": None,                   # logs: LogQL template; traces: path template
}

# string.Template syntax (${var}) so LogQL braces need no escaping.
# Variables: service_name, probe, probe_id, replica, tenant, trace_id
DEFAULT_QUERIES = {
    "logs_query": '{service_name="${service_name}"} | probe_check="logs_query" '
                  '| probe_id="${probe_id}" | probe_replica="${replica}"',
    "traces_query": "/api/traces/${trace_id}",
}


class ConfigError(ValueError):
    pass


def parse_otlp_headers(raw: str) -> dict:
    """OTEL_EXPORTER_OTLP_HEADERS format: k=v,k2=v2 with URL-encoded values."""
    out = {}
    for part in filter(None, (p.strip() for p in (raw or "").split(","))):
        if "=" not in part:
            raise ConfigError(f"bad OTLP header entry: {part!r}")
        k, v = part.split("=", 1)
        out[k.strip()] = urllib.parse.unquote(v.strip())
    return out


@dataclass
class Tenant:
    name: str
    otlp_endpoint: str
    otlp_headers: dict
    datasources: dict          # {"mimir": uid, "loki": uid, "tempo": uid}


@dataclass
class Promise:
    name: str
    kind: str
    signal: str
    tenants: list
    deadline_seconds: int
    latency_objective_seconds: int
    absent_for_seconds: int
    slo_target: float
    slo_window_days: int
    firing_seconds: int
    count: int
    poll_interval_seconds: int
    query: str | None


@dataclass
class Config:
    probe_name: str
    replica: str
    service_name: str
    period_seconds: int
    listen_port: int
    webhook_token: str
    export_interval_seconds: int
    grafana_url: str
    grafana_token: str
    grafana_ca_file: str | None
    self_metrics_tenant: str
    tenants: dict = field(default_factory=dict)
    promises: dict = field(default_factory=dict)
    gcp: dict = field(default_factory=dict)
    disable_export: bool = False

    def tenant_promises(self):
        """Yield (promise, tenant) for every enabled combination."""
        for p in self.promises.values():
            for t in p.tenants:
                yield p, self.tenants[t]


def _secret(section: dict, key: str, env, required: bool, where: str) -> str:
    var = section.get(key)
    if not var:
        if required:
            raise ConfigError(f"{where}.{key} must name an environment variable")
        return ""
    value = env.get(var, "")
    if required and not value:
        raise ConfigError(f"environment variable {var} ({where}.{key}) is empty")
    return value


def load(path: str | None = None, env=os.environ, require_secrets: bool = True) -> Config:
    path = path or env.get("PROBE_CONFIG", "/etc/heartbeat-probe/config.yaml")
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return from_dict(raw, env, require_secrets)


def from_dict(raw: dict, env=os.environ, require_secrets: bool = True) -> Config:
    probe = raw.get("probe") or {}
    webhook = raw.get("webhook") or {}
    grafana = raw.get("grafana") or {}

    tenants = {}
    for t in raw.get("tenants") or []:
        name = t.get("name")
        if not name or name in tenants:
            raise ConfigError(f"tenant name missing or duplicated: {name!r}")
        otlp = t.get("otlp") or {}
        if not otlp.get("endpoint"):
            raise ConfigError(f"tenants[{name}].otlp.endpoint is required")
        headers = parse_otlp_headers(_secret(otlp, "headers_env", env, require_secrets, f"tenants[{name}].otlp"))
        tenants[name] = Tenant(name, otlp["endpoint"].rstrip("/"), headers, dict(t.get("datasources") or {}))
    if not tenants:
        raise ConfigError("at least one tenant is required")

    promises = {}
    for name, opts in (raw.get("promises") or {}).items():
        if name not in PROMISE_TYPES:
            raise ConfigError(f"unknown promise {name!r}; valid: {sorted(PROMISE_TYPES)}")
        merged = {**PROMISE_DEFAULTS, **(opts or {})}
        if not merged["enabled"]:
            continue
        kind, signal = PROMISE_TYPES[name]
        p_tenants = merged["tenants"] or list(tenants)
        unknown = set(p_tenants) - set(tenants)
        if unknown:
            raise ConfigError(f"promise {name} references unknown tenants {sorted(unknown)}")
        need_ds = {"logs_alert": "loki", "logs_query": "loki", "traces_query": "tempo",
                   "metrics_alert": "mimir"}[name]
        for t in p_tenants:
            if not tenants[t].datasources.get(need_ds):
                raise ConfigError(f"promise {name} needs tenants[{t}].datasources.{need_ds}")
        promises[name] = Promise(
            name=name, kind=kind, signal=signal, tenants=list(p_tenants),
            deadline_seconds=int(merged["deadline_seconds"]),
            latency_objective_seconds=int(merged["latency_objective_seconds"]),
            absent_for_seconds=int(merged["absent_for_seconds"]),
            slo_target=float(merged["slo_target"]),
            slo_window_days=int(merged["slo_window_days"]),
            firing_seconds=int(merged["firing_seconds"]),
            count=int(merged["count"]),
            poll_interval_seconds=int(merged["poll_interval_seconds"]),
            query=merged["query"] or DEFAULT_QUERIES.get(name),
        )
    if not promises:
        raise ConfigError("no promise is enabled")

    period = int(probe.get("period_seconds", 300))
    for p in promises.values():
        if p.kind == "alert" and not 0 < p.firing_seconds < period:
            raise ConfigError(f"{p.name}: need 0 < firing_seconds < period_seconds")
        if not 0 < p.deadline_seconds <= period:
            raise ConfigError(f"{p.name}: need 0 < deadline_seconds <= period_seconds")
        if p.kind == "query" and p.count < 1:
            raise ConfigError(f"{p.name}: count must be >= 1")
        if not 0 < p.slo_target < 1:
            raise ConfigError(f"{p.name}: slo_target must be between 0 and 1")

    needs_grafana = any(p.kind == "query" for p in promises.values())
    grafana_url = (grafana.get("url") or "").rstrip("/")
    if needs_grafana and not grafana_url:
        raise ConfigError("grafana.url is required for query promises")

    self_tenant = probe.get("self_metrics_tenant") or next(iter(tenants))
    if self_tenant not in tenants:
        raise ConfigError(f"probe.self_metrics_tenant {self_tenant!r} is not a tenant")

    replica = env.get("REPLICA_ID") or env.get("HOSTNAME") or socket.gethostname()
    return Config(
        probe_name=probe.get("name", "e2e"),
        replica=replica,
        service_name=probe.get("service_name", "heartbeat-probe"),
        period_seconds=period,
        listen_port=int(env.get("LISTEN_PORT") or webhook.get("listen_port", 8080)),
        webhook_token=_secret(webhook, "token_env", env, require_secrets, "webhook"),
        export_interval_seconds=int(probe.get("export_interval_seconds", 15)),
        grafana_url=grafana_url,
        grafana_token=_secret(grafana, "token_env", env, require_secrets and needs_grafana, "grafana"),
        grafana_ca_file=grafana.get("ca_file"),
        self_metrics_tenant=self_tenant,
        tenants=tenants,
        promises=promises,
        gcp=dict(raw.get("gcp") or {}),
        disable_export=env.get("PROBE_DISABLE_EXPORT", "") == "1",
    )
