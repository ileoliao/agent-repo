import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yaml

import render
from fakes import free_port

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLE = os.path.join(ROOT, "config.example.yaml")


def test_grafana_one_rule_per_alert_promise_tenant_instance(tmp_path):
    assert render.main(["render", "--config", EXAMPLE, "--out", str(tmp_path)]) == 0
    cps = yaml.safe_load((tmp_path / "grafana/contact-points.yaml").read_text())["contactPoints"]
    assert {c["name"]: c["receivers"][0]["settings"] for c in cps} == {
        "heartbeat-probe-e2e-a": {"url": "http://heartbeat-probe-e2e-a.observability.svc/webhook", "httpMethod": "POST"},
        "heartbeat-probe-e2e-b": {"url": "http://heartbeat-probe-e2e-b.observability.svc/webhook", "httpMethod": "POST"}}
    assert all(c["receivers"][0]["disableResolveMessage"] for c in cps)

    rules = yaml.safe_load((tmp_path / "grafana/alert-rules.yaml").read_text())["groups"][0]["rules"]
    assert len(rules) == 8 and len({r["uid"] for r in rules}) == 8
    for r in rules:
        inst = r["labels"]["probe_instance"]
        assert r["notification_settings"]["receiver"] == f"heartbeat-probe-{inst}"   # webhook goes to its owner
        assert r["noDataState"] == "OK" and r["execErrState"] == "OK"
        assert all(f'probe_instance="{inst}"' in d["model"]["expr"] for d in r["data"] if "expr" in d["model"])
        assert '%.0f' in r["annotations"]["probe_id"] and len(r["uid"]) <= 40
    logs_rule = next(r for r in rules if r["labels"] == {"promise": "logs_alert", "tenant": "team-b",
                                                         "probe_instance": "e2e-a"})
    assert logs_rule["data"][0]["datasourceUid"] == "loki-team-b"
    assert "unwrap probe_id [120s]" in logs_rule["data"][0]["model"]["expr"]


def test_gcp_objects(tmp_path):
    render.main(["render", "--config", EXAMPLE, "--out", str(tmp_path)])
    gcp = {p.name: json.loads(p.read_text()) for p in (tmp_path / "gcp").iterdir()}
    assert sorted(n for n in gcp if n.startswith("log-metric-")) == [
        "log-metric-heartbeat_check.json", "log-metric-heartbeat_check_latency.json"]
    m = gcp["log-metric-heartbeat_check.json"]
    assert 'jsonPayload.event="check_result"' in m["filter"] and '("e2e-a" OR "e2e-b")' in m["filter"]
    assert m["labelExtractors"]["probe_instance"] == "EXTRACT(jsonPayload.instance)"
    assert set(m["labelExtractors"]) == {"promise", "tenant", "probe_instance", "ok", "reason"}

    policies = sorted((v for k, v in gcp.items() if k.startswith("policy-")), key=lambda p: p["displayName"])
    assert [(p["displayName"], p["severity"], p["notificationChannels"][0].rsplit("/", 1)[-1]) for p in policies] == [
        ("[heartbeat-probe] platform broken", "CRITICAL", "1234567890"),
        ("[heartbeat-probe] probe instance silent", "WARNING", "1234567891"),
        ("[heartbeat-probe] promise degraded", "WARNING", "1234567891")]
    q = {p["displayName"]: p["conditions"][0]["conditionPrometheusQueryLanguage"]["query"] for p in policies}
    broken = q["[heartbeat-probe] platform broken"]
    assert 'ok="false"' in broken and "unless on (promise, tenant)" in broken and 'ok="true"' in broken
    assert ">= 3" in q["[heartbeat-probe] promise degraded"] and "[3600s]" in q["[heartbeat-probe] promise degraded"]
    silent = q["[heartbeat-probe] probe instance silent"]
    assert silent.count("absent_over_time") == 2 and 'probe_instance="e2e-b"' in silent

    slos = {k: v for k, v in gcp.items() if k.startswith("slo-")}
    assert len(slos) == 8
    s = slos["slo-logs-query-team-a.json"]
    ratio = s["serviceLevelIndicator"]["requestBased"]["goodTotalRatio"]
    assert s["goal"] == 0.999 and s["rollingPeriod"] == f"{28 * 86400}s"
    assert ratio["goodServiceFilter"] == ratio["totalServiceFilter"] + ' AND metric.label.ok="true"'
    assert 'tenant="team-a"' in ratio["totalServiceFilter"] and "heartbeat_check" in ratio["totalServiceFilter"]


def test_long_names_get_short_unique_uids():
    a = render.uid("hb", "traces_query", "a-very-long-tenant-name-x", "instance-number-one")
    b = render.uid("hb", "traces_query", "a-very-long-tenant-name-x", "instance-number-two")
    assert len(a) <= 40 and len(b) <= 40 and a != b


class FakeGcp:
    def __init__(self):
        self.calls = []
        self.existing_metrics = ["heartbeat_check", "heartbeat_check_started", "heartbeat_check_ok", "other_metric"]
        self.slos = ["metrics-alert-team-a", "old-promise-team-z"]
        self.policies = [
            {"name": "projects/my-gcp-project/alertPolicies/1", "displayName": "[heartbeat-probe/e2e] old v2"},
            {"name": "projects/my-gcp-project/alertPolicies/2", "displayName": "[heartbeat-probe] platform broken"},
            {"name": "projects/my-gcp-project/alertPolicies/3", "displayName": "someone else's"}]
        g = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _do(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                g.calls.append((self.command, self.path.split("?")[0], body))
                code, out = g.route(self.command, self.path, body)
                data = json.dumps(out).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _do

        self.port = free_port()
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def route(self, method, path, body):
        if method == "POST" and path.endswith("/metrics"):
            return (409, {}) if body["name"] in self.existing_metrics else (200, body)
        if method == "GET" and "/metrics" in path:
            return 200, {"metrics": [{"name": n} for n in self.existing_metrics]}
        if method == "POST" and "/services?serviceId=" in path:
            return 409, {}
        if method == "POST" and "serviceLevelObjectiveId=" in path:
            return (409, {}) if path.split("=")[-1] in self.slos else (200, {})
        if method == "GET" and path.endswith("/serviceLevelObjectives"):
            return 200, {"serviceLevelObjectives": [
                {"name": f"projects/my-gcp-project/services/heartbeat-probe/serviceLevelObjectives/{s}"}
                for s in self.slos]}
        if method == "GET" and "alertPolicies" in path:
            return 200, {"alertPolicies": self.policies}
        return 200, {}


def test_apply_upserts_prunes_and_replaces_only_own_objects():
    fake = FakeGcp()
    try:
        objs = render.gcp_objects(render.build(EXAMPLE))
        url = f"http://127.0.0.1:{fake.port}"
        errors = render.apply(objs, render.Gcp("tok", url, url), replace_policies=True, prune=True,
                              out=lambda *_: None)
    finally:
        fake.server.shutdown()
    assert errors == 0
    calls = [(m, p) for m, p, _ in fake.calls]
    P = "/v2/projects/my-gcp-project/metrics"
    assert ("PUT", f"{P}/heartbeat_check") in calls
    assert {p for m, p in calls if m == "DELETE" and p.startswith(P)} == {
        f"{P}/heartbeat_check_started", f"{P}/heartbeat_check_ok"}            # v2 leftovers, not other_metric
    S = "/v3/projects/my-gcp-project/services/heartbeat-probe/serviceLevelObjectives"
    assert ("PATCH", f"{S}/metrics-alert-team-a") in calls
    assert ("DELETE", f"{S}/old-promise-team-z") in calls
    assert sum(1 for m, p in calls if m == "POST" and p == S) == 8          # existing one then PATCHed
    assert sum(1 for m, p in calls if m == "PATCH") == 1
    deleted_policies = {p for m, p in calls if m == "DELETE" and "alertPolicies" in p}
    assert deleted_policies == {"/v3/projects/my-gcp-project/alertPolicies/1",
                                "/v3/projects/my-gcp-project/alertPolicies/2"}
    assert sum(1 for m, p in calls if m == "POST" and p.endswith("/alertPolicies")) == 3
