"""Two independent instances x two tenants against a fake OTLP endpoint and a
fake Grafana that serves Loki/Tempo reads from what was actually ingested.
The test plays Grafana's alerting: once an instance's alert signal has been
ingested, it delivers the notification to THAT instance's own webhook, plus a
duplicate and a misrouted copy that must not create verdicts."""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

import yaml

from fakes import FakeGrafana, FakeOtlp, free_port

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUTH = {"team-a": "Basic YTpw", "team-b": "Basic Yjpw"}
INSTANCES = ["e2e-a", "e2e-b"]
PROMISES = ["metrics_alert", "logs_alert", "logs_query", "traces_query"]


def write_config(tmp_path, otlp, grafana, ports):
    cfg = {
        "probe": {"period_seconds": 8, "export_interval_seconds": 1, "self_metrics_tenant": "team-a"},
        "instances": [{"name": i, "webhook_url": f"http://127.0.0.1:{ports[i]}/webhook"} for i in INSTANCES],
        "grafana": {"url": grafana.url, "token_env": "GRAFANA_TOKEN"},
        "tenants": [
            {"name": t, "otlp": {"endpoint": otlp.url, "headers_env": f"OTLP_{t.upper().replace('-', '_')}"},
             "datasources": {"mimir": f"mimir-{t}", "loki": f"loki-{t}", "tempo": f"tempo-{t}"}}
            for t in AUTH],
        "promises": {
            "metrics_alert": {"firing_seconds": 4, "deadline_seconds": 7},
            "logs_alert": {"firing_seconds": 4, "deadline_seconds": 7},
            "logs_query": {"count": 4, "deadline_seconds": 6, "poll_interval_seconds": 1},
            "traces_query": {"count": 3, "deadline_seconds": 6, "poll_interval_seconds": 1},
        },
    }
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(cfg))
    return str(path)


def start(instance, cfg_path, port, lines):
    env = {**os.environ, "PROBE_CONFIG": cfg_path, "PROBE_INSTANCE": instance, "LISTEN_PORT": str(port),
           "GRAFANA_TOKEN": "gtok",
           "OTLP_TEAM_A": "Authorization=Basic%20YTpw", "OTLP_TEAM_B": "Authorization=Basic%20Yjpw"}
    env.pop("OTEL_SERVICE_NAME", None)
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "app.py")], env=env, cwd=ROOT,
                            stdout=subprocess.PIPE, text=True)
    threading.Thread(target=lambda: [lines.append(json.loads(l)) for l in proc.stdout], daemon=True).start()
    return proc


def post(port, alerts):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/webhook", method="POST",
                                 data=json.dumps({"alerts": alerts}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def ingested(otlp, promise, tenant, instance, probe_id):
    """Has this instance's alert signal for this cycle reached the backend?"""
    if promise == "metrics_alert":
        return any(m["tenant"] == tenant and m["name"] == "heartbeat.probe.id" and m["value"] == probe_id
                   and m["attrs"].get("probe_instance") == instance for m in list(otlp.metrics))
    return any(r["tenant"] == tenant and r["attrs"].get("probe.check") == "logs_alert"
               and r["attrs"].get("probe.instance") == instance and r["attrs"].get("probe.id") == probe_id
               for r in list(otlp.logs))


def test_two_instances_two_tenants_every_promise(tmp_path):
    otlp = FakeOtlp({v: k for k, v in AUTH.items()})
    grafana = FakeGrafana(otlp, "gtok", {f"{ds}-{t}": t for t in AUTH for ds in ("loki", "tempo")})
    ports = {i: free_port() for i in INSTANCES}
    cfg_path = write_config(tmp_path, otlp, grafana, ports)
    lines = []
    procs = [start(i, cfg_path, ports[i], lines) for i in INSTANCES]
    want = {(p, t, i) for p in PROMISES for t in AUTH for i in INSTANCES}
    answered = set()

    def ok_results():
        return {(l["promise"], l["tenant"], l["instance"]) for l in list(lines)
                if l["event"] == "check_result" and l["ok"]}

    try:
        deadline = time.time() + 40
        while time.time() < deadline and not want <= ok_results():
            for c in [l for l in list(lines) if l["event"] == "cycle_started"]:
                inst, pid = c["instance"], c["probe_id"]
                for promise in ("metrics_alert", "logs_alert"):
                    for tenant in AUTH:
                        key = (promise, tenant, inst, pid)
                        if key in answered or not ingested(otlp, promise, tenant, inst, pid):
                            continue
                        alert = {"status": "firing",
                                 "labels": {"promise": promise, "tenant": tenant, "probe_instance": inst},
                                 "annotations": {"probe_id": str(pid)}}
                        other = INSTANCES[1 - INSTANCES.index(inst)]
                        assert post(ports[inst], [alert]) == 200          # the real notification
                        assert post(ports[inst], [alert]) == 200          # Grafana duplicate
                        assert post(ports[other], [alert]) == 200         # misrouted copy
                        answered.add(key)
            time.sleep(0.2)
        assert post(ports["e2e-a"], [{"status": "resolved"}, "junk"]) == 200
        time.sleep(1)
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait(timeout=15)
        otlp.server.shutdown()
        grafana.server.shutdown()

    missing = want - ok_results()
    assert not missing, f"missing ok verdicts: {sorted(missing)}"
    results = [l for l in lines if l["event"] == "check_result"]
    assert not [r for r in results if not r["ok"]], [r for r in results if not r["ok"]][:3]

    # exactly one verdict per check, despite duplicates and misrouted copies
    per_check = Counter((r["promise"], r["tenant"], r["instance"], r["probe_id"]) for r in results)
    assert set(per_check.values()) == {1}
    reasons = Counter(l["reason"] for l in lines if l["event"] == "webhook_ignored")
    assert reasons["unmatched"] >= len(answered) and reasons["other_instance"] >= len(answered)

    # each instance waited for a cycle boundary before measuring
    for i in INSTANCES:
        events = [l["event"] for l in lines if l.get("instance") == i]
        assert events.index("waiting_for_next_cycle") < events.index("cycle_started")

    # the GCP contract: every verdict carries the fields the log metrics extract
    for r in results:
        assert {"severity", "time", "promise", "signal", "tenant", "instance", "probe_id", "ok"} <= set(r)
        assert "latency_seconds" in r

    # tenant isolation: each tenant's data arrived with its own credential
    assert otlp.rejected == 0
    for rec in otlp.logs + otlp.metrics:
        assert rec["resource"]["probe.tenant"] == rec["tenant"]
    assert {r["resource"]["service.instance.id"] for r in otlp.metrics} == set(INSTANCES)
    trace_sizes = Counter(s["trace_id"] for s in otlp.spans)
    assert set(trace_sizes.values()) == {3}

    # self metrics only in the configured tenant, with the expected shapes
    kinds = {m["name"]: (m["kind"], m["unit"]) for m in otlp.metrics}
    assert kinds["heartbeat.probe.checks"] == ("sum", "{check}")
    assert kinds["heartbeat.probe.checks.latency"] == ("histogram", "s")
    assert kinds["heartbeat.probe.webhook.ignored"] == ("sum", "{alert}")
    assert {m["tenant"] for m in otlp.metrics if m["name"].startswith("heartbeat.probe.checks")} == {"team-a"}
    gauges = {(m["tenant"], m["attrs"]["probe_instance"]) for m in otlp.metrics if m["name"] == "heartbeat.probe.state"}
    assert gauges == {(t, i) for t in AUTH for i in INSTANCES}

    # reads went through the Grafana proxy with the right datasource per tenant
    assert {uid for uid, _, _ in grafana.queries} == {f"{ds}-{t}" for t in AUTH for ds in ("loki", "tempo")}
