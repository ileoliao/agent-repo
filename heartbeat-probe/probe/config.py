"""Configuration: one YAML file is the single source of truth.

The same file drives every probe instance at runtime and `render.py`
(Grafana rules and contact points, GCP log metrics, alert policies, SLOs).
Each running process picks its identity from $PROBE_INSTANCE, which must be
one of `instances[].name`. Secrets never live in the file: fields ending in
`_env` name an environment variable that holds the value.
"""

from __future__ import annotations

import os
import re
import urllib.parse
from dataclasses import dataclass, field

import yaml

# promise name -> (kind, signal, datasource it reads through)
PROMISE_TYPES = {
    "metrics_alert": ("alert", "metrics", "mimir"),
    "logs_alert": ("alert", "logs", "loki"),
    "logs_query": ("query", "logs", "loki"),
    "traces_query": ("query", "traces", "tempo"),
}

PROMISE_DEFAULTS = {
    "enabled": True,
    "tenants": None,              # None = all tenants
    "deadline_seconds": 300,      # THE promise: a check passes only within this time
    "slo_target": 0.999,          # share of checks that pass
    "slo_window_days": 28,
    "firing_seconds": 120,        # alert promises: gauge stays 1 / LogQL lookback
    "count": 10,                  # query promises: items written and expected back
    "poll_interval_seconds": 5,
    "query": None,                # query promises: template, see DEFAULT_QUERIES
}

# string.Template syntax (${var}); variables: service_name, probe_id, instance, tenant, trace_id
DEFAULT_QUERIES = {
    "logs_query": '{service_name="${service_name}"} | probe_check="logs_query" '
                  '| probe_id="${probe_id}" | probe_instance="${instance}"',
    "traces_query": "/api/traces/${trace_id}",
}

ALERTING_DEFAULTS = {
    "broken_window_seconds": 900,      # page: no instance passed, at least one failed
    "degraded_failures": 3,            # ticket: this many failures ...
    "degraded_window_seconds": 3600,   # ... within this window
    "silent_window_seconds": 900,      # ticket: an instance produced no results
}

NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")


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
class Instance:
    name: str
    webhook_url: str


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
    datasource: str
    tenants: list
    deadline_seconds: int
    slo_target: float
    slo_window_days: int
    firing_seconds: int
    count: int
    poll_interval_seconds: int
    query: str | None


@dataclass
class Config:
    instance: str                      # this process's identity ("" when rendering)
    instances: dict
    service_name: str
    period_seconds: int
    export_interval_seconds: int
    listen_port: int
    grafana_url: str
    grafana_token: str
    grafana_ca_file: str | None
    grafana: dict
    self_metrics_tenant: str
    tenants: dict = field(default_factory=dict)
    promises: dict = field(default_factory=dict)
    alerting: dict = field(default_factory=dict)
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


def load(path: str | None = None, env=os.environ) -> Config:
    """Runtime load: requires $PROBE_INSTANCE and all secrets."""
    path = path or env.get("PROBE_CONFIG", "/etc/heartbeat-probe/config.yaml")
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return from_dict(raw, env, runtime=True)


def from_dict(raw: dict, env=os.environ, runtime: bool = True) -> Config:
    probe = raw.get("probe") or {}
    webhook = raw.get("webhook") or {}
    grafana = raw.get("grafana") or {}

    instances = {}
    for i in raw.get("instances") or []:
        name = (i or {}).get("name", "")
        if not NAME_RE.match(name):
            raise ConfigError(f"instance name {name!r} must be lowercase letters, digits and '-' (max 40)")
        if name in instances:
            raise ConfigError(f"instance {name!r} is listed twice")
        if not i.get("webhook_url"):
            raise ConfigError(f"instances[{name}].webhook_url is required")
        instances[name] = Instance(name, i["webhook_url"])
    if not instances:
        raise ConfigError("at least one entry in `instances` is required")

    instance = ""
    if runtime:
        instance = env.get("PROBE_INSTANCE", "")
        if instance not in instances:
            raise ConfigError(f"PROBE_INSTANCE={instance!r} is not one of {sorted(instances)}")

    tenants = {}
    for t in raw.get("tenants") or []:
        name = (t or {}).get("name", "")
        if not NAME_RE.match(name) or name in tenants:
            raise ConfigError(f"tenant name invalid or duplicated: {name!r}")
        otlp = t.get("otlp") or {}
        if not otlp.get("endpoint"):
            raise ConfigError(f"tenants[{name}].otlp.endpoint is required")
        headers = parse_otlp_headers(_secret(otlp, "headers_env", env, runtime, f"tenants[{name}].otlp"))
        tenants[name] = Tenant(name, otlp["endpoint"].rstrip("/"), headers, dict(t.get("datasources") or {}))
    if not tenants:
        raise ConfigError("at least one tenant is required")

    period = int(probe.get("period_seconds", 300))
    promises = {}
    for name, opts in (raw.get("promises") or {}).items():
        if name not in PROMISE_TYPES:
            raise ConfigError(f"unknown promise {name!r}; valid: {sorted(PROMISE_TYPES)}")
        unknown_keys = set(opts or {}) - set(PROMISE_DEFAULTS)
        if unknown_keys:
            raise ConfigError(f"promise {name}: unknown settings {sorted(unknown_keys)}")
        m = {**PROMISE_DEFAULTS, **(opts or {})}
        if not m["enabled"]:
            continue
        kind, signal, ds = PROMISE_TYPES[name]
        p_tenants = list(m["tenants"] or tenants)
        unknown = set(p_tenants) - set(tenants)
        if unknown:
            raise ConfigError(f"promise {name} references unknown tenants {sorted(unknown)}")
        for t in p_tenants:
            if not tenants[t].datasources.get(ds):
                raise ConfigError(f"promise {name} needs tenants[{t}].datasources.{ds}")
        p = Promise(name=name, kind=kind, signal=signal, datasource=ds, tenants=p_tenants,
                    deadline_seconds=int(m["deadline_seconds"]), slo_target=float(m["slo_target"]),
                    slo_window_days=int(m["slo_window_days"]), firing_seconds=int(m["firing_seconds"]),
                    count=int(m["count"]), poll_interval_seconds=int(m["poll_interval_seconds"]),
                    query=m["query"] or DEFAULT_QUERIES.get(name))
        if not 0 < p.deadline_seconds <= period:
            raise ConfigError(f"{name}: need 0 < deadline_seconds <= period_seconds")
        if kind == "alert" and not 0 < p.firing_seconds < period:
            raise ConfigError(f"{name}: need 0 < firing_seconds < period_seconds")
        if kind == "query" and (p.count < 1 or p.poll_interval_seconds < 1):
            raise ConfigError(f"{name}: count and poll_interval_seconds must be >= 1")
        if not 0 < p.slo_target < 1:
            raise ConfigError(f"{name}: slo_target must be between 0 and 1")
        promises[name] = p
    if not promises:
        raise ConfigError("no promise is enabled")

    grafana_url = (grafana.get("url") or "").rstrip("/")
    needs_grafana = any(p.kind == "query" for p in promises.values())
    if needs_grafana and not grafana_url:
        raise ConfigError("grafana.url is required for query promises")

    self_tenant = probe.get("self_metrics_tenant") or next(iter(tenants))
    if self_tenant not in tenants:
        raise ConfigError(f"probe.self_metrics_tenant {self_tenant!r} is not a tenant")

    gcp = dict(raw.get("gcp") or {})
    alerting = {**ALERTING_DEFAULTS, **(gcp.pop("alerting", None) or {})}

    return Config(
        instance=instance,
        instances=instances,
        service_name=probe.get("service_name", "heartbeat-probe"),
        period_seconds=period,
        export_interval_seconds=int(probe.get("export_interval_seconds", 15)),
        listen_port=int(env.get("LISTEN_PORT") or webhook.get("listen_port", 8080)),
        grafana_url=grafana_url,
        grafana_token=_secret(grafana, "token_env", env, runtime and needs_grafana, "grafana"),
        grafana_ca_file=grafana.get("ca_file"),
        grafana=grafana,
        self_metrics_tenant=self_tenant,
        tenants=tenants,
        promises=promises,
        alerting={k: int(v) for k, v in alerting.items()},
        gcp=gcp,
        disable_export=env.get("PROBE_DISABLE_EXPORT", "") == "1",
    )
