import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import app  # noqa: E402

T0 = 1_760_538_000  # aligned to 300s


# ---------------------------------------------------------- unit tests ----

@pytest.fixture
def logs(monkeypatch):
    out = []
    monkeypatch.setattr(app, "log", lambda sev, ev, **f: out.append({"severity": sev, "event": ev, **f}))
    return out


def make_probe(replica="heartbeat-probe-0"):
    return app.Probe(app.Config({"PROBE_PERIOD_SECONDS": "300", "PROBE_FIRING_SECONDS": "120",
                                 "PROBE_TIMEOUT_SECONDS": "300", "WEBHOOK_TOKEN": "t",
                                 "REPLICA_ID": replica}))


def alert(pid, status="firing", replica="heartbeat-probe-0", probe="e2e"):
    return {"status": status, "labels": {"probe": probe, "replica": replica},
            "annotations": {"probe_id": str(pid)}}


def received(logs):
    return [l for l in logs if l["event"] == "alert_received"]


def test_sender_cycle(logs):
    p = make_probe()
    for t in range(T0, T0 + 300):
        p.tick(t)
    p.tick(T0 + 300)
    ev = [(l["event"], l["probe_id"]) for l in logs]
    assert ev == [("probe_sent", T0), ("probe_cleared", T0), ("probe_sent", T0 + 300)]
    assert all(l["replica"] == "heartbeat-probe-0" for l in logs)


def test_restart_mid_firing_logs_sent_again_once(logs):
    p = make_probe()
    for t in range(T0 + 50, T0 + 100):   # fresh process starting mid-cycle
        p.tick(t)
    assert [l["event"] for l in logs] == ["probe_sent"]


def test_any_replica_can_receive_and_match(logs):
    receiver = make_probe("heartbeat-probe-1")       # did NOT send this probe
    receiver.handle_alert(alert(T0, replica="heartbeat-probe-0"), T0 + 45)
    receiver.handle_alert(alert(T0, "resolved", replica="heartbeat-probe-0"), T0 + 160)
    r = received(logs)
    assert [x["matched"] for x in r] == [True, True]
    assert r[0]["replica"] == "heartbeat-probe-0" and r[0]["received_by"] == "heartbeat-probe-1"
    assert r[0]["latency_seconds"] == 45
    assert r[1]["latency_seconds"] == 40          # measured from clear time T0+120


def test_late_notification_is_not_success(logs):
    make_probe().handle_alert(alert(T0), T0 + 301)
    assert received(logs)[0]["matched"] is False and received(logs)[0]["reason"] == "late"


def test_lossy_scientific_id_is_rejected(logs):
    make_probe().handle_alert(alert("1.76054e+09"), T0 + 10)
    assert received(logs)[0]["reason"] == "probe_id_not_aligned"


def test_full_precision_float_string_is_accepted(logs):
    make_probe().handle_alert(alert(f"{T0}.0"), T0 + 10)
    assert received(logs)[0]["matched"] is True


def test_future_missing_duplicate_and_foreign(logs):
    p = make_probe()
    p.handle_alert(alert(T0 + 600), T0)                       # from the future
    p.handle_alert({"status": "firing", "labels": {"probe": "e2e"}, "annotations": {}}, T0)
    p.handle_alert(alert(T0), T0 + 30)
    p.handle_alert(alert(T0), T0 + 60)                         # repeat notification
    p.handle_alert(alert(T0, probe="other"), T0 + 61)          # another probe: ignored
    r = received(logs)
    assert [x.get("reason") for x in r] == ["from_future", "missing_or_bad_probe_id", None, "duplicate"]
    assert [x["matched"] for x in r] == [False, False, True, False]


class RecordingTelemetry(app.Telemetry):
    def __init__(self):
        self.calls = []

    def sent(self):
        self.calls.append(("sent",))

    def notification(self, origin, status, matched, reason, latency):
        self.calls.append(("notification", origin, status, matched, reason, latency))


def test_telemetry_mirrors_outcomes(logs):
    p = make_probe()
    tel = p.telemetry = RecordingTelemetry()
    p.tick(T0)
    p.handle_alert(alert(T0), T0 + 30)
    p.handle_alert(alert(T0), T0 + 31)
    p.handle_alert(alert(T0), T0 + 400)
    assert tel.calls == [
        ("sent",),
        ("notification", "heartbeat-probe-0", "firing", True, None, 30),
        ("notification", "heartbeat-probe-0", "firing", False, "duplicate", None),
        ("notification", "heartbeat-probe-0", "firing", False, "late", None),
    ]


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
        self.kinds = {}    # metric_name -> (data kind, unit)
        self.resources = []
        recv = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                req = ExportMetricsServiceRequest()
                req.ParseFromString(self.rfile.read(int(self.headers["Content-Length"])))
                auth = self.headers.get("Authorization")
                for rm in req.resource_metrics:
                    res = {a.key: a.value.string_value for a in rm.resource.attributes}
                    recv.resources.append(res)
                    for sm in rm.scope_metrics:
                        for m in sm.metrics:
                            kind = m.WhichOneof("data")
                            for dp in getattr(m, kind).data_points:
                                attrs = {a.key: a.value.string_value for a in dp.attributes}
                                if kind == "histogram":
                                    v = (dp.count, dp.sum, list(dp.explicit_bounds))
                                else:
                                    v = dp.as_int if dp.HasField("as_int") else dp.as_double
                                recv.points.append((m.name, v, attrs, auth))
                                recv.kinds[m.name] = (kind, m.unit)
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
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def start_replica(name, otlp_port, lines):
    port = free_port()
    env = {**os.environ,
           "PROBE_PERIOD_SECONDS": "6", "PROBE_FIRING_SECONDS": "3", "PROBE_TIMEOUT_SECONDS": "5",
           "METRIC_EXPORT_INTERVAL_SECONDS": "1", "LISTEN_PORT": str(port), "WEBHOOK_TOKEN": "s3cret",
           "REPLICA_ID": name,
           "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{otlp_port}",
           "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic%20dGVhbTpwdw==",
           "OTEL_SERVICE_NAME": "heartbeat-probe"}
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "app.py")], env=env,
                            stdout=subprocess.PIPE, text=True)
    threading.Thread(target=lambda: [lines.append(json.loads(l)) for l in proc.stdout], daemon=True).start()
    return proc, f"http://127.0.0.1:{port}"


def healthz(base):
    return json.load(urllib.request.urlopen(base + "/healthz", timeout=2))


def test_two_replicas_cross_delivery():
    otlp = FakeOtlp()
    lines = []
    pa, a = start_replica("heartbeat-probe-0", otlp.port, lines)
    pb, b = start_replica("heartbeat-probe-1", otlp.port, lines)
    try:
        deadline, snap = time.time() + 15, {}
        while time.time() < deadline:
            try:
                healthz(b)                       # receiver must be listening too
                snap = healthz(a)
                if snap["state"] == 1:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        assert snap.get("state") == 1
        pid = snap["probe_id"]

        payload = {"status": "firing", "alerts": [
            {"status": "firing", "labels": {"probe": "e2e", "replica": "heartbeat-probe-0"},
             "annotations": {"probe_id": str(pid)}}]}
        assert post(b + "/webhook", payload, "wrong") == 401
        assert post(b + "/webhook", payload, "s3cret") == 200     # replica 0's probe lands on replica 1
        time.sleep(2.5)                                          # let both export a few points
    finally:
        for p in (pa, pb):
            p.terminate()
        for p in (pa, pb):
            p.wait(timeout=10)
        otlp.server.shutdown()

    m = [l for l in lines if l["event"] == "alert_received"]
    assert len(m) == 1 and m[0]["matched"] is True
    assert m[0]["replica"] == "heartbeat-probe-0" and m[0]["received_by"] == "heartbeat-probe-1"
    assert {l["replica"] for l in lines if l["event"] == "probe_sent"} == {"heartbeat-probe-0", "heartbeat-probe-1"}
    assert any(l["event"] == "webhook_unauthorized" for l in lines)
    assert all({"severity", "message", "time"} <= set(l) for l in lines)

    assert otlp.kinds == {
        "heartbeat.probe.state": ("gauge", ""),
        "heartbeat.probe.id": ("gauge", ""),
        "heartbeat.probe.sent": ("sum", "{probe}"),
        "heartbeat.probe.notifications": ("sum", "{notification}"),
        "heartbeat.probe.latency": ("histogram", "s"),
        "heartbeat.probe.webhook.rejected": ("sum", "{request}"),
    }
    assert all(p[2]["probe"] == "e2e" for p in otlp.points)
    assert all(h == "Basic dGVhbTpwdw==" for *_, h in otlp.points)
    gauges = [p for p in otlp.points if p[0] in ("heartbeat.probe.state", "heartbeat.probe.id")]
    assert {p[2]["replica"] for p in gauges} == {"heartbeat-probe-0", "heartbeat-probe-1"}
    assert any(n == "heartbeat.probe.id" and v == pid for n, v, *_ in gauges)

    # self-observability: cumulative values, so look at the latest point per series
    def last(name, **match):
        vals = [v for n, v, a, _ in otlp.points if n == name and all(a.get(k) == x for k, x in match.items())]
        return vals[-1] if vals else None

    assert last("heartbeat.probe.sent", replica="heartbeat-probe-0") >= 1
    assert last("heartbeat.probe.sent", replica="heartbeat-probe-1") >= 1
    assert last("heartbeat.probe.notifications", replica="heartbeat-probe-0",
                received_by="heartbeat-probe-1", status="firing", matched="true", reason="none") == 1
    count, total, bounds = last("heartbeat.probe.latency", replica="heartbeat-probe-0", status="firing")
    assert count == 1 and 0 <= total <= 5 and bounds == [float(b) for b in app.LATENCY_BUCKETS]
    assert last("heartbeat.probe.webhook.rejected", received_by="heartbeat-probe-1", reason="unauthorized") == 1
    assert {r.get("service.name") for r in otlp.resources} == {"heartbeat-probe"}
    assert {r.get("service.instance.id") for r in otlp.resources} == {"heartbeat-probe-0", "heartbeat-probe-1"}
