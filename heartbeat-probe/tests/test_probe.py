import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import app  # noqa: E402


# ---------------------------------------------------------- unit tests ----

@pytest.fixture
def logs(monkeypatch):
    out = []
    monkeypatch.setattr(app, "log", lambda sev, ev, **f: out.append({"severity": sev, "event": ev, **f}))
    return out


def make_probe(**over):
    env = {"PROBE_PERIOD_SECONDS": "300", "PROBE_FIRING_SECONDS": "120",
           "PROBE_TIMEOUT_SECONDS": "300", "WEBHOOK_TOKEN": "t", **over}
    return app.Probe(app.Config(env))


def firing(pid, status="firing"):
    return {"status": status, "labels": {"probe": "e2e"}, "annotations": {"probe_id": str(pid)}}


def events(logs, name):
    return [l for l in logs if l["event"] == name]


def test_full_cycle_matched(logs):
    p = make_probe()
    t0 = 1_000_200  # cycle start: 1_000_200 - (1_000_200 % 300) = 1_000_200
    p.tick(t0)
    assert p.state == 1 and p.probe_id == t0
    p.handle_alert(firing(f"{t0}"), t0 + 45)
    p.tick(t0 + 121)                      # firing phase over
    assert p.state == 0
    p.handle_alert(firing(t0, "resolved"), t0 + 160)

    fired = [l for l in events(logs, "alert_received") if l["status"] == "firing"]
    resolved = [l for l in events(logs, "alert_received") if l["status"] == "resolved"]
    assert fired[0]["matched"] is True and fired[0]["latency_seconds"] == 45
    assert resolved[0]["matched"] is True and resolved[0]["latency_seconds"] == 39
    assert not events(logs, "probe_timeout")


def test_float_string_id_is_accepted(logs):
    # The rule template uses printf "%.0f"; a full-precision float string must also match.
    p = make_probe()
    t0 = 1_760_538_000
    p.tick(t0)
    p.handle_alert(firing("1760538000.0"), t0 + 10)
    assert events(logs, "alert_received")[0]["matched"] is True


def test_lossy_scientific_id_does_not_match(logs):
    # Default %g formatting ("1.76054e+09") loses digits -> must NOT be counted as success.
    p = make_probe()
    t0 = 1_760_538_000
    p.tick(t0)
    p.handle_alert(firing("1.76054e+09"), t0 + 10)
    assert events(logs, "alert_received")[0]["matched"] is False


def test_timeout_when_no_notification(logs):
    p = make_probe()
    t0 = 1_000_200
    for t in range(t0, t0 + 302):
        p.tick(t)
    to = events(logs, "probe_timeout")
    assert len(to) == 1 and to[0]["probe_id"] == t0 and to[0]["severity"] == "ERROR"
    # a late notification is reported as unmatched, not as success
    p.handle_alert(firing(t0), t0 + 305)
    assert events(logs, "alert_received")[-1]["matched"] is False


def test_duplicate_and_unknown(logs):
    p = make_probe()
    t0 = 1_000_200
    p.tick(t0)
    p.handle_alert(firing(t0), t0 + 30)
    p.handle_alert(firing(t0), t0 + 60)       # repeat notification
    p.handle_alert(firing(123), t0 + 61)      # stale / foreign id
    p.handle_alert({"status": "firing", "labels": {"probe": "e2e"}, "annotations": {}}, t0 + 62)
    recv = events(logs, "alert_received")
    assert [r["matched"] for r in recv] == [True, False, False, False]
    assert recv[1]["reason"] == "duplicate"
    assert recv[2]["reason"] == "unknown_or_late"
    assert recv[3]["reason"] == "missing_or_bad_probe_id"


def test_other_probe_label_ignored(logs):
    p = make_probe()
    p.tick(1_000_200)
    p.handle_alert({"status": "firing", "labels": {"probe": "other"},
                    "annotations": {"probe_id": "1000200"}}, 1_000_210)
    assert not events(logs, "alert_received")


def test_restart_mid_cycle_sends_once(logs):
    p = make_probe()
    t0 = 1_000_200
    for t in range(t0, t0 + 60):
        p.tick(t)
    assert len(events(logs, "probe_sent")) == 1


def test_bad_config():
    with pytest.raises(ValueError):
        app.Config({"PROBE_PERIOD_SECONDS": "60", "PROBE_FIRING_SECONDS": "60", "WEBHOOK_TOKEN": "t"})
    with pytest.raises(ValueError):
        app.Config({})


# ----------------------------------------------------- integration test ----

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class FakeOtlp:
    """Minimal OTLP/HTTP metrics receiver that decodes protobuf payloads."""

    def __init__(self):
        from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
            ExportMetricsServiceRequest, ExportMetricsServiceResponse)
        self.points = []   # (metric_name, value, attrs, auth_header)
        recv = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                req = ExportMetricsServiceRequest()
                req.ParseFromString(body)
                for rm in req.resource_metrics:
                    for sm in rm.scope_metrics:
                        for m in sm.metrics:
                            for dp in m.gauge.data_points:
                                v = dp.as_int if dp.HasField("as_int") else dp.as_double
                                attrs = {a.key: a.value.string_value for a in dp.attributes}
                                recv.points.append((m.name, v, attrs, self.headers.get("Authorization")))
                out = ExportMetricsServiceResponse().SerializeToString()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-protobuf")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        self.port = free_port()
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def post(url, payload, token):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def test_end_to_end_with_fake_otlp_and_simulated_grafana():
    otlp = FakeOtlp()
    port = free_port()
    env = {**os.environ,
           "PROBE_PERIOD_SECONDS": "6", "PROBE_FIRING_SECONDS": "3", "PROBE_TIMEOUT_SECONDS": "5",
           "METRIC_EXPORT_INTERVAL_SECONDS": "1", "LISTEN_PORT": str(port), "WEBHOOK_TOKEN": "s3cret",
           "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{otlp.port}",
           "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic%20dGVhbTpwdw==",
           "OTEL_SERVICE_NAME": "heartbeat-probe"}
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "app.py")], env=env,
                            stdout=subprocess.PIPE, text=True)
    lines = []
    threading.Thread(target=lambda: [lines.append(json.loads(l)) for l in proc.stdout], daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        # wait for a firing phase, then answer exactly as Grafana would
        deadline = time.time() + 15
        snap = {}
        while time.time() < deadline:
            try:
                snap = json.load(urllib.request.urlopen(base + "/healthz", timeout=2))
                if snap["state"] == 1:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        assert snap.get("state") == 1
        pid = snap["probe_id"]

        grafana_payload = {"receiver": "heartbeat-probe-webhook", "status": "firing",
                           "alerts": [{"status": "firing", "labels": {"alertname": "E2E Heartbeat Probe", "probe": "e2e"},
                                       "annotations": {"probe_id": str(pid)}}]}
        assert post(base + "/webhook", grafana_payload, "wrong") == 401
        assert post(base + "/webhook", grafana_payload, "s3cret") == 200

        # let this probe clear, resolve it, then ignore the next one so it times out
        while json.load(urllib.request.urlopen(base + "/healthz"))["state"] == 1:
            time.sleep(0.2)
        grafana_payload["alerts"][0]["status"] = "resolved"
        assert post(base + "/webhook", grafana_payload, "s3cret") == 200
        time.sleep(9)
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        otlp.server.shutdown()

    ev = [l["event"] for l in lines]
    recv = [l for l in lines if l["event"] == "alert_received"]
    assert recv[0]["status"] == "firing" and recv[0]["matched"] is True and recv[0]["probe_id"] == pid
    assert recv[1]["status"] == "resolved" and recv[1]["matched"] is True
    assert "webhook_unauthorized" in ev
    assert any(l["event"] == "probe_timeout" and l["probe_id"] != pid for l in lines)
    assert all({"severity", "message", "time"} <= set(l) for l in lines)

    names = {p[0] for p in otlp.points}
    assert names == {"heartbeat.probe.state", "heartbeat.probe.id"}
    assert any(n == "heartbeat.probe.id" and v == pid for n, v, *_ in otlp.points)
    assert {v for n, v, *_ in otlp.points if n == "heartbeat.probe.state"} == {0, 1}
    assert all(a == {"probe": "e2e"} for *_, a, _ in otlp.points)
    assert all(h == "Basic dGVhbTpwdw==" for *_, h in otlp.points)
