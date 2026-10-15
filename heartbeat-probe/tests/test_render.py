import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yaml

import render
from fakes import free_port

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLE = os.path.join(ROOT, "config.example.yaml")


def test_render_writes_consistent_files(tmp_path):
    assert render.main(["render", "--config", EXAMPLE, "--out", str(tmp_path)]) == 0
    rules = yaml.safe_load((tmp_path / "grafana/alert-rules.yaml").read_text())["groups"][0]["rules"]
    assert {(r["labels"]["promise"], r["labels"]["tenant"]) for r in rules} == {
        (p, t) for p in ("metrics_alert", "logs_alert") for t in ("team-a", "team-b")}
    for r in rules:
        assert r["noDataState"] == "OK" and r["execErrState"] == "OK"
        assert '%.0f' in r["annotations"]["probe_id"]
        assert "replica" in r["notification_settings"]["group_by"]
    logs_rule = next(r for r in rules if r["labels"] == {"probe": "e2e", "promise": "logs_alert", "tenant": "team-b"})
    assert logs_rule["data"][0]["datasourceUid"] == "loki-team-b"
    assert "unwrap probe_id [120s]" in logs_rule["data"][0]["model"]["expr"]
    assert "$values.A" in logs_rule["annotations"]["probe_id"]

    gcp = {p.name: json.loads(p.read_text()) for p in (tmp_path / "gcp").iterdir()}
    assert len([n for n in gcp if n.startswith("log-metric-")]) == 4
    assert len([n for n in gcp if n.startswith("slo-")]) == 8
    assert len([n for n in gcp if n.startswith("policy-")]) == 4 * 3 + 8
    slo = gcp["slo-logs-query-team-a.json"]
    assert slo["goal"] == 0.999 and slo["rollingPeriod"] == f"{28 * 86400}s"
    ratio = slo["serviceLevelIndicator"]["requestBased"]["goodTotalRatio"]
    assert 'heartbeat_check_ok' in ratio["goodServiceFilter"] and 'tenant="team-a"' in ratio["goodServiceFilter"]
    assert 'heartbeat_check_started' in ratio["totalServiceFilter"]
    slow = next(v for k, v in gcp.items() if k.endswith("logs-query-slow.json"))
    assert slow["conditions"][0]["conditionThreshold"]["thresholdValue"] == 30


class FakeGcp:
    def __init__(self):
        self.calls, self.existing_metrics = [], {"heartbeat_check_ok"}
        self.policies = [{"name": "projects/my-gcp-project/alertPolicies/1",
                          "displayName": "[heartbeat-probe/e2e] old"},
                         {"name": "projects/my-gcp-project/alertPolicies/2", "displayName": "someone else's"}]
        g = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _do(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                g.calls.append((self.command, self.path, body))
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
        if method == "POST" and "/services?serviceId=" in path:
            return 409, {}
        if method == "GET" and "alertPolicies" in path:
            return 200, {"alertPolicies": self.policies}
        return 200, {}


def test_apply_upserts_and_replaces_only_own_policies():
    fake = FakeGcp()
    try:
        cfg, _ = render.build(EXAMPLE)
        objs = render.gcp_objects(cfg)
        url = f"http://127.0.0.1:{fake.port}"
        errors = render.apply(objs, render.Gcp("tok", url, url), replace_policies=True, out=lambda *_: None)
    finally:
        fake.server.shutdown()
    assert errors == 0
    methods = [(m, p.split("?")[0]) for m, p, _ in fake.calls]
    assert ("PUT", "/v2/projects/my-gcp-project/metrics/heartbeat_check_ok") in methods
    assert ("DELETE", "/v3/projects/my-gcp-project/alertPolicies/1") in methods
    assert ("DELETE", "/v3/projects/my-gcp-project/alertPolicies/2") not in methods
    assert sum(1 for m, p in methods if m == "POST" and p.endswith("/alertPolicies")) == 20
    assert sum(1 for m, p in methods if m == "POST" and p.endswith("/serviceLevelObjectives")) == 8
