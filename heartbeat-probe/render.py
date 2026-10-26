#!/usr/bin/env python3
"""
Generate everything that must agree with the probe configuration.

  python render.py render --config config.yaml --out build/
      build/grafana/contact-points.yaml   one webhook contact point per instance
      build/grafana/alert-rules.yaml      one rule per (alert promise, tenant, instance)
      build/gcp/*.json                    log metrics, alert policies, service, SLOs

  python render.py apply --config config.yaml [--replace-policies] [--prune]
      renders, then creates/updates the GCP objects through the REST APIs
      (token from `gcloud auth print-access-token`, or $GCP_ACCESS_TOKEN)

GCP model (one verdict per check, so plain counting is exact):
  log metric  heartbeat_check          labels promise, tenant, probe_instance, ok, reason
  log metric  heartbeat_check_latency  passed checks only
  policy  broken   (page)    a promise/tenant had failures and NO instance passed
  policy  degraded (ticket)  >= N failed checks for a promise/tenant in a window
  policy  silent   (ticket)  an instance produced no verdict at all
  SLO     per promise x tenant: passed / all verdicts over slo_window_days
"""

from __future__ import annotations

import argparse
import hashlib
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

PREFIX = "[heartbeat-probe]"
LATENCY_BOUNDS = [5, 15, 30, 45, 60, 90, 120, 180, 240, 300]
PROM = "logging_googleapis_com:user_heartbeat_check"


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", s.lower()).strip("-")


def uid(*parts: str) -> str:
    """Grafana UIDs are limited to 40 characters; keep them readable and unique."""
    s = slug("-".join(parts))
    if len(s) <= 40:
        return s
    return f"{s[:31]}-{hashlib.sha1(s.encode()).hexdigest()[:8]}"


# ------------------------------------------------------------- grafana ----

def contact_point_name(instance: str) -> str:
    return f"heartbeat-probe-{instance}"


def grafana_files(cfg: config_mod.Config) -> dict:
    folder = cfg.grafana.get("alert_folder", "Platform Heartbeat")
    contact_points = {"apiVersion": 1, "contactPoints": [{
        "orgId": 1, "name": contact_point_name(i.name),
        "receivers": [{
            "uid": uid("hb-cp", i.name), "type": "webhook",
            "disableResolveMessage": True,          # only firing notifications produce verdicts
            "settings": {"url": i.webhook_url, "httpMethod": "POST"},
        }],
    } for i in cfg.instances.values()]}

    stale_after = max(90, 4 * cfg.export_interval_seconds)
    rules = []
    for p, t in cfg.tenant_promises():
        if p.kind != "alert":
            continue
        for inst in cfg.instances:
            sel = f'probe_instance="{inst}"'
            if p.name == "metrics_alert":
                ds = t.datasources["mimir"]
                data = [
                    _query("A", ds, f"max(heartbeat_probe_state{{{sel}}}) and on() "
                                    f"(time() - max(timestamp(heartbeat_probe_state{{{sel}}})) < {stale_after})"),
                    _query("B", ds, f"max(heartbeat_probe_id{{{sel}}})"),
                ]
                id_ref = "B"
            else:  # logs_alert: probe_id is read back from the log record itself
                ds = t.datasources["loki"]
                data = [_query("A", ds, f'max(max_over_time({{service_name="{cfg.service_name}"}} '
                                        f'| probe_check="logs_alert" | {sel} '
                                        f'| unwrap probe_id [{p.firing_seconds}s]))', loki=True)]
                id_ref = "A"
            data.append({"refId": "C", "datasourceUid": "__expr__", "model": {
                "refId": "C", "type": "threshold", "expression": "A",
                "conditions": [{"evaluator": {"type": "gt", "params": [0]}}]}})
            rules.append({
                "uid": uid("hb", p.name, t.name, inst),
                "title": f"Heartbeat {p.name} {t.name} {inst}",
                "condition": "C",
                "data": data,
                # Any failure must surface as silence (-> timeout verdict), never as a fake notification.
                "noDataState": "OK",
                "execErrState": "OK",
                "for": "0s",
                "labels": {"promise": p.name, "tenant": t.name, "probe_instance": inst},
                "annotations": {
                    # %.0f keeps every digit; default formatting (1.76e+09) would never match.
                    "probe_id": '{{ printf "%.0f" $values.' + id_ref + '.Value }}',
                    "summary": f"Synthetic {p.name} probe ({t.name}, {inst}); expected to fire every cycle.",
                },
                "notification_settings": {
                    "receiver": contact_point_name(inst),
                    "group_by": ["alertname", "promise", "tenant", "probe_instance"],
                    "group_wait": "0s", "group_interval": "30s", "repeat_interval": "4h",
                },
            })
    out = {"grafana/contact-points.yaml": contact_points}
    if rules:
        out["grafana/alert-rules.yaml"] = {"apiVersion": 1, "groups": [{
            "orgId": 1, "name": "heartbeat-probe", "folder": folder, "interval": "30s", "rules": rules}]}
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
    gcp, a = cfg.gcp, cfg.alerting
    project = gcp.get("project_id") or "PROJECT_ID"
    page = f"projects/{project}/notificationChannels/{gcp.get('page_channel_id', 'CHANNEL_ID')}"
    ticket = f"projects/{project}/notificationChannels/{gcp.get('ticket_channel_id') or gcp.get('page_channel_id', 'CHANNEL_ID')}"
    scope = gcp.get("log_scope") or \
        'resource.type="k8s_container" AND resource.labels.container_name="heartbeat-probe"'
    names = " OR ".join(f'"{i}"' for i in cfg.instances)
    base = f'{scope} AND jsonPayload.event="check_result" AND jsonPayload.instance=({names})'

    def labels(keys):
        return [{"key": k, "valueType": "STRING"} for k in keys]

    def extract(keys):
        src = {"probe_instance": "instance"}
        return {k: f"EXTRACT(jsonPayload.{src.get(k, k)})" for k in keys}

    k_all = ["promise", "tenant", "probe_instance", "ok", "reason"]
    k_lat = ["promise", "tenant", "probe_instance"]
    metrics = [
        {"name": "heartbeat_check", "description": "One entry per check verdict",
         "filter": base,
         "metricDescriptor": {"metricKind": "DELTA", "valueType": "INT64", "labels": labels(k_all)},
         "labelExtractors": extract(k_all)},
        {"name": "heartbeat_check_latency", "description": "Latency of passed checks",
         "filter": f"{base} AND jsonPayload.ok=true",
         "metricDescriptor": {"metricKind": "DELTA", "valueType": "DISTRIBUTION", "unit": "s",
                              "labels": labels(k_lat)},
         "labelExtractors": extract(k_lat),
         "valueExtractor": "EXTRACT(jsonPayload.latency_seconds)",
         "bucketOptions": {"explicitBuckets": {"bounds": LATENCY_BOUNDS}}},
    ]

    def promql_policy(name, severity, channel, query, doc):
        return {"displayName": f"{PREFIX} {name}", "combiner": "OR", "severity": severity,
                "conditions": [{"displayName": name, "conditionPrometheusQueryLanguage": {
                    "query": query, "duration": "0s", "evaluationInterval": "60s"}}],
                "notificationChannels": [channel], "alertStrategy": {"autoClose": "3600s"},
                "documentation": {"mimeType": "text/markdown", "content": doc}}

    bw, dw, sw = a["broken_window_seconds"], a["degraded_window_seconds"], a["silent_window_seconds"]
    by = "sum by (promise, tenant)"
    policies = [
        promql_policy(
            "platform broken", "CRITICAL", page,
            f'({by} (increase({PROM}{{ok="false"}}[{bw}s])) > 0)\n'
            f'unless on (promise, tenant)\n'
            f'({by} (increase({PROM}{{ok="true"}}[{bw}s])) > 0)',
            f"No probe instance kept the `promise` for `tenant` in the last {bw}s, and at least one "
            "instance reported a failure. The platform is breaking this promise. See the failing "
            "checks' `reason` in Logs Explorer: `jsonPayload.event=\"check_result\" AND jsonPayload.ok=false`."),
        promql_policy(
            "promise degraded", "WARNING", ticket,
            f'{by} (increase({PROM}{{ok="false"}}[{dw}s])) >= {a["degraded_failures"]}',
            f"At least {a['degraded_failures']} failed checks in {dw}s for this promise and tenant. "
            "If all failures come from one probe_instance, suspect that instance's node or zone first."),
        promql_policy(
            "probe instance silent", "WARNING", ticket,
            "\nor\n".join(f'absent_over_time({PROM}{{probe_instance="{i}"}}[{sw}s])' for i in cfg.instances),
            f"A probe instance produced no verdict for {sw}s: the instance is down, cannot start, "
            "or its logs do not reach Cloud Logging. Platform verdicts for it are void meanwhile."),
    ]

    service_id = "heartbeat-probe"
    slos = []
    for p, t in cfg.tenant_promises():
        f = (f'metric.type="logging.googleapis.com/user/heartbeat_check" '
             f'AND metric.label.promise="{p.name}" AND metric.label.tenant="{t.name}"')
        slos.append({"id": slug(f"{p.name}-{t.name}"), "body": {
            "displayName": f"{p.name} ({t.name})",
            "goal": p.slo_target,
            "rollingPeriod": f"{p.slo_window_days * 86400}s",
            "serviceLevelIndicator": {"requestBased": {"goodTotalRatio": {
                "goodServiceFilter": f'{f} AND metric.label.ok="true"',
                "totalServiceFilter": f}}},
        }})
    return {"project": project, "metrics": metrics, "policies": policies,
            "service": {"id": service_id, "body": {"displayName": "heartbeat-probe", "custom": {}}},
            "slos": slos}


def gcp_files(objs: dict) -> dict:
    out = {f"gcp/log-metric-{m['name']}.json": m for m in objs["metrics"]}
    out["gcp/service.json"] = objs["service"]
    for s in objs["slos"]:
        out[f"gcp/slo-{s['id']}.json"] = s["body"]
    for i, p in enumerate(objs["policies"], 1):
        out[f"gcp/policy-{i}-{slug(p['displayName'])}.json"] = p
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


def apply(objs: dict, gcp: Gcp, replace_policies: bool, prune: bool, out=print) -> int:
    proj, errors = objs["project"], 0
    L, M = f"{gcp.logging_url}/v2/projects/{proj}", f"{gcp.monitoring_url}/v3/projects/{proj}"

    def check(what, status, body, ok=(200,)):
        nonlocal errors
        if status in ok:
            out(f"ok      {what}")
        else:
            errors += 1
            out(f"ERROR   {what}: HTTP {status} {json.dumps(body)[:300]}")

    wanted_metrics = {m["name"] for m in objs["metrics"]}
    for m in objs["metrics"]:
        st, body = gcp.call("POST", f"{L}/metrics", m)
        if st == 409:
            st, body = gcp.call("PUT", f"{L}/metrics/{m['name']}", m)
        check(f"log metric {m['name']}", st, body)
    if prune:
        st, body = gcp.call("GET", f"{L}/metrics?pageSize=1000")
        for m in (body.get("metrics") or []) if st == 200 else []:
            if m["name"].startswith("heartbeat_") and m["name"] not in wanted_metrics:
                dst, dbody = gcp.call("DELETE", f"{L}/metrics/{m['name']}")
                check(f"prune log metric {m['name']}", dst, dbody)

    svc = objs["service"]
    st, body = gcp.call("POST", f"{M}/services?serviceId={svc['id']}", svc["body"])
    check(f"service {svc['id']}", st, body, ok=(200, 409))
    base = f"{M}/services/{svc['id']}/serviceLevelObjectives"
    for s in objs["slos"]:
        st, body = gcp.call("POST", f"{base}?serviceLevelObjectiveId={s['id']}", s["body"])
        if st == 409:
            st, body = gcp.call("PATCH", f"{base}/{s['id']}?updateMask=displayName,goal,rollingPeriod,"
                                         "serviceLevelIndicator", s["body"])
        check(f"slo {s['id']}", st, body)
    if prune:
        wanted = {s["id"] for s in objs["slos"]}
        st, body = gcp.call("GET", base)
        for s in (body.get("serviceLevelObjectives") or []) if st == 200 else []:
            if s["name"].rsplit("/", 1)[-1] not in wanted:
                dst, dbody = gcp.call("DELETE", f"{gcp.monitoring_url}/v3/{s['name']}")
                check(f"prune slo {s['name'].rsplit('/', 1)[-1]}", dst, dbody)

    if replace_policies:
        st, body = gcp.call("GET", f"{M}/alertPolicies?pageSize=1000")
        for p in (body.get("alertPolicies") or []) if st == 200 else []:
            # also matches older "[heartbeat-probe/<name>] ..." policies
            if p.get("displayName", "").startswith("[heartbeat-probe"):
                dst, dbody = gcp.call("DELETE", f"{gcp.monitoring_url}/v3/{p['name']}")
                check(f"delete policy {p['displayName']}", dst, dbody)
    for p in objs["policies"]:
        st, body = gcp.call("POST", f"{M}/alertPolicies", p)
        check(f"policy {p['displayName']}", st, body)
    return errors


# ---------------------------------------------------------------- main ----

def build(config_path: str) -> config_mod.Config:
    with open(config_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return config_mod.from_dict(raw, env=os.environ, runtime=False)


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
                    help="delete existing policies named [heartbeat-probe... before creating them")
    ap.add_argument("--prune", action="store_true",
                    help="delete heartbeat_* log metrics and SLOs that the config no longer produces")
    args = ap.parse_args(argv)

    cfg = build(args.config)
    objs = gcp_objects(cfg)
    files = {**grafana_files(cfg), **gcp_files(objs)}
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
    errors = apply(objs, gcp, args.replace_policies, args.prune)
    if not args.replace_policies:
        print("note: policies are created, not updated; use --replace-policies to avoid duplicates on re-run")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
