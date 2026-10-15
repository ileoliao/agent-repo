#!/usr/bin/env python3
"""
Generate everything that must agree with the probe's config.

  python render.py render --config config.yaml --out build/
      -> build/grafana/contact-point.yaml      Grafana provisioning
         build/grafana/alert-rules.yaml        one rule per (alert promise, tenant)
         build/gcp/*.json                      log metrics, alert policies, SLOs

  python render.py apply  --config config.yaml [--replace-policies]
      -> renders, then creates/updates the GCP objects through the REST APIs
         (token from `gcloud auth print-access-token`, or $GCP_ACCESS_TOKEN)

GCP objects:
  log metrics   heartbeat_check_started / _ok / _failed / _latency
                (labels: promise, tenant, replica[, reason])
  per promise   "broken"  - no ok result for a (tenant, replica) for absent_for_seconds
                "failing" - 2+ explicit failures in 30 min (shows the reason)
                "slow"    - p95 latency above latency_objective_seconds
  per promise x tenant
                SLO       ok / started over slo_window_days, goal slo_target
                burn rate alert when the 1h burn rate exceeds gcp.fast_burn_rate
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe import config as config_mod  # noqa: E402

LOG_METRICS = {
    "heartbeat_check_started": ('jsonPayload.event="check_started"', "Checks started (replica = sender)"),
    "heartbeat_check_ok": ('jsonPayload.event="check_result" AND jsonPayload.ok=true',
                           "Successful checks (replica = sender of the check)"),
    "heartbeat_check_failed": ('jsonPayload.event="check_result" AND jsonPayload.ok=false',
                               "Explicitly failed checks"),
}
LATENCY_BOUNDS = [5, 15, 30, 45, 60, 90, 120, 180, 240, 300]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", s.lower()).strip("-")


# ------------------------------------------------------------- grafana ----

def grafana_files(cfg: config_mod.Config, raw: dict) -> dict:
    g = raw.get("grafana") or {}
    contact = g.get("contact_point", "heartbeat-probe-webhook")
    folder = g.get("alert_folder", "Platform Heartbeat")
    contact_point = {
        "apiVersion": 1,
        "contactPoints": [{
            "orgId": 1, "name": contact,
            "receivers": [{
                "uid": slug(contact)[:40], "type": "webhook", "disableResolveMessage": False,
                "settings": {
                    "url": g.get("webhook_url", "https://heartbeat-probe.example.internal/webhook"),
                    "httpMethod": "POST", "authorization_scheme": "Bearer",
                    "authorization_credentials": "$HEARTBEAT_WEBHOOK_TOKEN",
                },
            }],
        }],
    }

    rules = []
    for p, t in cfg.tenant_promises():
        if p.kind != "alert":
            continue
        labels = {"probe": cfg.probe_name, "promise": p.name, "tenant": t.name}
        sel = f'probe="{cfg.probe_name}"'
        if p.name == "metrics_alert":
            ds = t.datasources["mimir"]
            data = [
                _query("A", ds, f"max by (replica) (heartbeat_probe_state{{{sel}}}) and on (replica) "
                                f"(time() - max by (replica) (timestamp(heartbeat_probe_state{{{sel}}})) < 90)"),
                _query("B", ds, f"max by (replica) (heartbeat_probe_id{{{sel}}})"),
            ]
            id_ref = "B"
        else:  # logs_alert: the probe_id is read back from the log record itself
            ds = t.datasources["loki"]
            expr = (f'max by (probe_replica) (max_over_time({{service_name="{cfg.service_name}"}} '
                    f'| probe_check="logs_alert" | probe_name="{cfg.probe_name}" '
                    f'| unwrap probe_id [{p.firing_seconds}s]))')
            data = [_query("A", ds, expr, loki=True)]
            id_ref = "A"
        data.append({"refId": "C", "datasourceUid": "__expr__", "model": {
            "refId": "C", "type": "threshold", "expression": "A",
            "conditions": [{"evaluator": {"type": "gt", "params": [0]}}]}})
        rules.append({
            "uid": slug(f"hb-{cfg.probe_name}-{p.name}-{t.name}")[:40],
            "title": f"Heartbeat {p.name} ({t.name})",
            "condition": "C",
            "data": data,
            # Any failure must surface as silence, never as a fake notification.
            "noDataState": "OK",
            "execErrState": "OK",
            "for": "0s",
            "labels": labels,
            "annotations": {
                # %.0f keeps every digit; default formatting (1.76e+09) never validates.
                "probe_id": '{{ printf "%.0f" $values.' + id_ref + '.Value }}',
                "summary": f"Synthetic {p.name} probe for {t.name}; expected to fire every cycle.",
            },
            "notification_settings": {
                "receiver": contact,
                "group_by": ["alertname", "probe", "promise", "tenant", "replica", "probe_replica"],
                "group_wait": "0s", "group_interval": "30s", "repeat_interval": "4h",
            },
        })
    alert_rules = {"apiVersion": 1, "groups": [{
        "orgId": 1, "name": f"heartbeat-{cfg.probe_name}", "folder": folder,
        "interval": "30s", "rules": rules}]} if rules else None
    out = {"grafana/contact-point.yaml": contact_point}
    if alert_rules:
        out["grafana/alert-rules.yaml"] = alert_rules
    return out


def _query(ref: str, ds: str, expr: str, loki: bool = False) -> dict:
    model = {"refId": ref, "expr": expr}
    if loki:
        model["queryType"] = "instant"
    else:
        model["instant"] = True
    return {"refId": ref, "relativeTimeRange": {"from": 600, "to": 0}, "datasourceUid": ds, "model": model}


# ----------------------------------------------------------------- gcp ----

def gcp_objects(cfg: config_mod.Config) -> dict:
    gcp = cfg.gcp
    project = gcp.get("project_id") or "PROJECT_ID"
    channel = f"projects/{project}/notificationChannels/{gcp.get('notification_channel_id', 'CHANNEL_ID')}"
    scope = gcp.get("log_scope") or \
        'resource.type="k8s_container" AND resource.labels.container_name="heartbeat-probe"'
    base = f'{scope} AND jsonPayload.probe="{cfg.probe_name}"'
    labels = ["promise", "tenant", "replica"]
    prefix = f"[heartbeat-probe/{cfg.probe_name}]"

    def descriptor(kind, extra_labels=()):
        d = {"metricKind": "DELTA", "valueType": kind,
             "labels": [{"key": k, "valueType": "STRING"} for k in [*labels, *extra_labels]]}
        if kind == "DISTRIBUTION":
            d["unit"] = "s"
        return d

    def extractors(extra=()):
        return {k: f"EXTRACT(jsonPayload.{k})" for k in [*labels, *extra]}

    metrics = []
    for name, (flt, desc) in LOG_METRICS.items():
        extra = ("reason",) if name == "heartbeat_check_failed" else ()
        metrics.append({"name": name, "description": desc, "filter": f"{base} AND {flt}",
                        "metricDescriptor": descriptor("INT64", extra), "labelExtractors": extractors(extra)})
    metrics.append({
        "name": "heartbeat_check_latency", "description": "Latency of successful checks",
        "filter": f'{base} AND {LOG_METRICS["heartbeat_check_ok"][0]}',
        "metricDescriptor": descriptor("DISTRIBUTION"), "labelExtractors": extractors(),
        "valueExtractor": "EXTRACT(jsonPayload.latency_seconds)",
        "bucketOptions": {"explicitBuckets": {"bounds": LATENCY_BOUNDS}},
    })

    def mfilter(metric, promise, tenant=None):
        f = (f'metric.type="logging.googleapis.com/user/{metric}" '
             f'AND metric.label.promise="{promise}"')
        if tenant:
            f += f' AND metric.label.tenant="{tenant}"'
        return f

    def policy(name, condition, doc=None, auto_close="1800s"):
        p = {"displayName": f"{prefix} {name}", "combiner": "OR", "conditions": [condition],
             "notificationChannels": [channel], "alertStrategy": {"autoClose": auto_close}}
        if doc:
            p["documentation"] = {"mimeType": "text/markdown", "content": doc}
        return p

    by = ["metric.label.tenant", "metric.label.replica"]
    policies, slos = [], []
    service_id = slug(f"heartbeat-probe-{cfg.probe_name}")
    for p in cfg.promises.values():
        policies.append(policy(f"{p.name} broken", {
            "displayName": f"No successful {p.name} check for {p.absent_for_seconds}s",
            "conditionAbsent": {
                "filter": mfilter("heartbeat_check_ok", p.name),
                "aggregations": [{"alignmentPeriod": f"{cfg.period_seconds}s", "perSeriesAligner": "ALIGN_SUM",
                                  "crossSeriesReducer": "REDUCE_SUM", "groupByFields": by}],
                "duration": f"{p.absent_for_seconds}s", "trigger": {"count": 1}}},
            doc=(f"The `{p.name}` promise has not been met for the tenant/replica in the incident labels. "
                 "If check_started logs exist for it, the platform path is broken; if not, the probe "
                 "replica is down. All tenants at once usually means a shared component (Grafana, "
                 "Collector, Nginx) is down.")))
        policies.append(policy(f"{p.name} failing", {
            "displayName": "2+ failed checks in 30 min",
            "conditionThreshold": {
                "filter": mfilter("heartbeat_check_failed", p.name),
                "aggregations": [{"alignmentPeriod": "1800s", "perSeriesAligner": "ALIGN_SUM",
                                  "crossSeriesReducer": "REDUCE_SUM",
                                  "groupByFields": ["metric.label.tenant", "metric.label.reason"]}],
                "comparison": "COMPARISON_GT", "thresholdValue": 1, "duration": "0s",
                "trigger": {"count": 1}}},
            doc="Checks ran but explicitly failed; see `reason` (incomplete, not_found, late, query_error...).",
            auto_close="3600s"))
        policies.append(policy(f"{p.name} slow", {
            "displayName": f"p95 latency > {p.latency_objective_seconds}s",
            "conditionThreshold": {
                "filter": mfilter("heartbeat_check_latency", p.name),
                "aggregations": [{"alignmentPeriod": "1800s", "perSeriesAligner": "ALIGN_PERCENTILE_95",
                                  "crossSeriesReducer": "REDUCE_MAX", "groupByFields": ["metric.label.tenant"]}],
                "comparison": "COMPARISON_GT", "thresholdValue": p.latency_objective_seconds,
                "duration": "0s", "trigger": {"count": 1}}},
            auto_close="3600s"))
        for t in p.tenants:
            slo_id = slug(f"{p.name}-{t}")
            slos.append({
                "id": slo_id,
                "body": {
                    "displayName": f"{p.name} ({t})",
                    "goal": p.slo_target,
                    "rollingPeriod": f"{p.slo_window_days * 86400}s",
                    "serviceLevelIndicator": {"requestBased": {"goodTotalRatio": {
                        "goodServiceFilter": mfilter("heartbeat_check_ok", p.name, t),
                        "totalServiceFilter": mfilter("heartbeat_check_started", p.name, t)}}},
                },
            })
            slo_name = f"projects/{project}/services/{service_id}/serviceLevelObjectives/{slo_id}"
            policies.append(policy(f"{p.name} ({t}) SLO fast burn", {
                "displayName": f"1h burn rate > {gcp.get('fast_burn_rate', 10)}",
                "conditionThreshold": {
                    "filter": f'select_slo_burn_rate("{slo_name}", "60m")',
                    "comparison": "COMPARISON_GT", "thresholdValue": float(gcp.get("fast_burn_rate", 10)),
                    "duration": "0s", "trigger": {"count": 1}}},
                doc=f"Error budget of `{p.name}` for `{t}` (target {p.slo_target}) is burning fast.",
                auto_close="3600s"))

    return {
        "project": project, "prefix": prefix, "metrics": metrics, "policies": policies,
        "service": {"id": service_id, "body": {"displayName": f"heartbeat-probe {cfg.probe_name}", "custom": {}}},
        "slos": slos,
    }


def gcp_files(objs: dict) -> dict:
    out = {f"gcp/log-metric-{m['name']}.json": m for m in objs["metrics"]}
    out["gcp/service.json"] = objs["service"]
    for s in objs["slos"]:
        out[f"gcp/slo-{s['id']}.json"] = s["body"]
    for i, p in enumerate(objs["policies"], 1):
        out[f"gcp/policy-{i:02d}-{slug(p['displayName'])[:60]}.json"] = p
    return out


# --------------------------------------------------------------- apply ----

class Gcp:
    def __init__(self, token: str, logging_url: str, monitoring_url: str):
        self.token, self.logging_url, self.monitoring_url = token, logging_url, monitoring_url

    def call(self, method: str, url: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")


def apply(objs: dict, gcp: Gcp, replace_policies: bool, out=print) -> int:
    proj, errors = objs["project"], 0

    def check(what, status, body, ok=(200,)):
        nonlocal errors
        if status in ok:
            out(f"ok      {what}")
        else:
            errors += 1
            out(f"ERROR   {what}: HTTP {status} {json.dumps(body)[:300]}")

    for m in objs["metrics"]:
        st, body = gcp.call("POST", f"{gcp.logging_url}/v2/projects/{proj}/metrics", m)
        if st == 409:
            st, body = gcp.call("PUT", f"{gcp.logging_url}/v2/projects/{proj}/metrics/{m['name']}", m)
        check(f"log metric {m['name']}", st, body)

    svc = objs["service"]
    st, body = gcp.call("POST", f"{gcp.monitoring_url}/v3/projects/{proj}/services?serviceId={svc['id']}",
                        svc["body"])
    check(f"service {svc['id']}", st, body, ok=(200, 409))
    for s in objs["slos"]:
        base = f"{gcp.monitoring_url}/v3/projects/{proj}/services/{svc['id']}/serviceLevelObjectives"
        st, body = gcp.call("POST", f"{base}?serviceLevelObjectiveId={s['id']}", s["body"])
        if st == 409:
            st, body = gcp.call("PATCH", f"{base}/{s['id']}?updateMask=displayName,goal,rollingPeriod,"
                                         f"serviceLevelIndicator", s["body"])
        check(f"slo {s['id']}", st, body)

    if replace_policies:
        st, body = gcp.call("GET", f"{gcp.monitoring_url}/v3/projects/{proj}/alertPolicies?pageSize=1000")
        for existing in (body.get("alertPolicies") or []) if st == 200 else []:
            if existing.get("displayName", "").startswith(objs["prefix"]):
                dst, dbody = gcp.call("DELETE", f"{gcp.monitoring_url}/v3/{existing['name']}")
                check(f"delete policy {existing['displayName']}", dst, dbody)
    for p in objs["policies"]:
        st, body = gcp.call("POST", f"{gcp.monitoring_url}/v3/projects/{proj}/alertPolicies", p)
        check(f"policy {p['displayName']}", st, body)
    return errors


# ---------------------------------------------------------------- main ----

def build(config_path: str):
    with open(config_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    cfg = config_mod.from_dict(raw, env=os.environ, require_secrets=False)
    return cfg, raw


def write_files(files: dict, out_dir: str) -> None:
    for rel, content in files.items():
        path = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            if rel.endswith(".yaml"):
                yaml.safe_dump(content, f, sort_keys=False, allow_unicode=True, width=120)
            else:
                json.dump(content, f, indent=2, ensure_ascii=False)
                f.write("\n")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["render", "apply"])
    ap.add_argument("--config", default=os.environ.get("PROBE_CONFIG", "config.yaml"))
    ap.add_argument("--out", default="build")
    ap.add_argument("--replace-policies", action="store_true",
                    help="delete existing policies whose name starts with the probe prefix first")
    args = ap.parse_args(argv)

    cfg, raw = build(args.config)
    objs = gcp_objects(cfg)
    files = {**grafana_files(cfg, raw), **gcp_files(objs)}
    write_files(files, args.out)
    print(f"rendered {len(files)} files into {args.out}/")
    if args.command == "render":
        return 0

    if objs["project"] == "PROJECT_ID":
        print("gcp.project_id is not set", file=sys.stderr)
        return 2
    token = os.environ.get("GCP_ACCESS_TOKEN") or subprocess.run(
        ["gcloud", "auth", "print-access-token"], check=True, capture_output=True, text=True).stdout.strip()
    gcp = Gcp(token, os.environ.get("GCP_LOGGING_URL", "https://logging.googleapis.com"),
              os.environ.get("GCP_MONITORING_URL", "https://monitoring.googleapis.com"))
    errors = apply(objs, gcp, args.replace_policies)
    if not args.replace_policies:
        print("note: policies are created, not updated; use --replace-policies to avoid duplicates on re-run")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
