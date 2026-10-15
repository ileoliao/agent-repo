"""Two replicas x two tenants against a fake OTLP endpoint and a fake Grafana
that serves Loki/Tempo reads from what was actually ingested."""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

import yaml

from fakes import FakeGrafana, FakeOtlp, free_port

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUTH = {"team-a": "Basic YTpw", "team-b": "Basic Yjpw"}


def write_config(tmp_path, otlp, grafana):
    cfg = {
        "probe": {"name": "e2e", "period_seconds": 8, "export_interval_seconds": 1,
                  "self_metrics_tenant": "team-a"},
        "webhook": {"token_env": "WEBHOOK_TOKEN"},
        "grafana": {"url": grafana.url, "token_env": "GRAFANA_TOKEN"},
        "tenants": [
            {"name": t, "otlp": {"endpoint": otlp.url, "headers_env": f"OTLP_{t.upper().replace('-', '_')}"},
             "datasources": {"mimir": f"mimir-{t}", "loki": f"loki-{t}", "tempo": f"tempo-{t}"}}
            for t in AUTH],
        "promises": {
            "metrics_alert": {"firing_seconds": 4, "deadline_seconds": 8},
            "logs_alert": {"firing_seconds": 4, "deadline_seconds": 8},
            "logs_query": {"count": 4, "deadline_seconds": 5, "poll_interval_seconds": 1},
            "traces_query": {"count": 3, "deadline_seconds": 5, "poll_interval_seconds": 1},
        },
    }
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(cfg))
    return str(path)


def start(name, cfg_path, lines):
    port = free_port()
    env = {**os.environ, "PROBE_CONFIG": cfg_path, "REPLICA_ID": name, "LISTEN_PORT": str(port),
           "WEBHOOK_TOKEN": "hook", "GRAFANA_TOKEN": "gtok",
           "OTLP_TEAM_A": "Authorization=Basic%20YTpw", "OTLP_TEAM_B": "Authorization=Basic%20Yjpw"}
    env.pop("OTEL_SERVICE_NAME", None)
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "app.py")], env=env, cwd=ROOT,
                            stdout=subprocess.PIPE, text=True)
    threading.Thread(target=lambda: [lines.append(json.loads(l)) for l in proc.stdout], daemon=True).start()
    return proc, port


def post(port, alerts, token="hook"):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/webhook", method="POST",
                                 data=json.dumps({"alerts": alerts}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def ok_results(lines):
    return {(l["promise"], l["tenant"], l["replica"]) for l in lines
            if l["event"] == "check_result" and l["ok"]}


def test_all_promises_two_replicas_two_tenants(tmp_path):
    otlp = FakeOtlp({v: k for k, v in AUTH.items()})
    grafana = FakeGrafana(otlp, "gtok", {f"{ds}-{t}": t for t in AUTH for ds in ("loki", "tempo")})
    cfg_path = write_config(tmp_path, otlp, grafana)
    lines = []
    procs = [start("heartbeat-probe-0", cfg_path, lines), start("heartbeat-probe-1", cfg_path, lines)]
    (_, port0), (_, port1) = procs
    replicas = ["heartbeat-probe-0", "heartbeat-probe-1"]
    want = {(p, t, r) for p in ("logs_query", "traces_query", "metrics_alert", "logs_alert")
            for t in AUTH for r in replicas}
    sent_alerts = set()
    try:
        deadline = time.time() + 40
        while time.time() < deadline and not want <= ok_results(lines):
            # Play Grafana: answer each replica's alert signal, delivering to the OTHER replica.
            for l in [l for l in lines if l["event"] == "check_started" and l["promise"].endswith("_alert")]:
                key = (l["promise"], l["tenant"], l["replica"], l["probe_id"])
                if key in sent_alerts:
                    continue
                if l["promise"] == "logs_alert" and not any(
                        r["tenant"] == l["tenant"] and r["attrs"].get("probe.check") == "logs_alert"
                        and r["attrs"].get("probe.replica") == l["replica"]
                        and r["attrs"].get("probe.id") == l["probe_id"] for r in list(otlp.logs)):
                    continue  # not ingested yet
                label = "probe_replica" if l["promise"] == "logs_alert" else "replica"
                target = port1 if l["replica"] == replicas[0] else port0
                assert post(target, [{"status": "firing",
                                      "labels": {"probe": "e2e", "promise": l["promise"], "tenant": l["tenant"],
                                                 label: l["replica"]},
                                      "annotations": {"probe_id": str(l["probe_id"])}}]) == 200
                sent_alerts.add(key)
            time.sleep(0.3)
        assert post(port0, [], token="wrong") == 401
        time.sleep(1.5)
    finally:
        for p, _ in procs:
            p.terminate()
        for p, _ in procs:
            p.wait(timeout=15)
        otlp.server.shutdown()
        grafana.server.shutdown()

    missing = want - ok_results(lines)
    assert not missing, f"missing ok results: {sorted(missing)}"
    bad = [l for l in lines if l["event"] == "check_result" and not l["ok"]]
    assert not bad, bad[:3]

    # alert webhooks were validated by the replica that did NOT send the probe
    for l in lines:
        if l["event"] == "check_result" and l["promise"].endswith("_alert"):
            assert l["received_by"] != l["replica"]

    # every log line carries the schema GCP relies on
    for l in lines:
        assert {"severity", "message", "time", "event"} <= set(l)
        if l["event"] in ("check_started", "check_result"):
            assert {"probe", "promise", "signal", "tenant", "replica", "probe_id"} <= set(l)

    # tenant isolation: each tenant's data arrived with its own credentials
    assert otlp.rejected == 0
    for rec in otlp.logs + otlp.metrics:
        assert rec["resource"]["probe.tenant"] == rec["tenant"]
    assert {s["tenant"] for s in otlp.spans} == set(AUTH)
    trace_sizes = {}
    for s in otlp.spans:
        trace_sizes[s["trace_id"]] = trace_sizes.get(s["trace_id"], 0) + 1
    assert set(trace_sizes.values()) == {3}

    # gauges in both tenants, self metrics only in the configured tenant
    names = {(m["tenant"], m["name"]) for m in otlp.metrics}
    for t in AUTH:
        assert (t, "heartbeat.probe.state") in names and (t, "heartbeat.probe.id") in names
    self_metrics = {m["tenant"] for m in otlp.metrics if m["name"].startswith("heartbeat.probe.checks")}
    assert self_metrics == {"team-a"}
    kinds = {m["name"]: (m["kind"], m["unit"]) for m in otlp.metrics}
    assert kinds["heartbeat.probe.checks.latency"] == ("histogram", "s")
    assert kinds["heartbeat.probe.webhook.rejected"] == ("sum", "{request}")
    assert {m["resource"]["service.name"] for m in otlp.metrics} == {"heartbeat-probe"}

    # reads went through the Grafana proxy with the right datasource per tenant
    used = {uid for uid, _, _ in grafana.queries}
    assert used == {f"{ds}-{t}" for t in AUTH for ds in ("loki", "tempo")}
