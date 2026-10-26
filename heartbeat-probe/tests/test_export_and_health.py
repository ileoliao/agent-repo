"""Real OTel exporters against a rejecting endpoint, and the health check."""

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import yaml

import app
from fakes import free_port
from probe import checks as checks_mod
from probe import config, pipelines, report
from probe.report import Telemetry

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {"GRAFANA_TOKEN": "g", "PROBE_INSTANCE": "e2e-a", "OTLP_HEADERS_TEAM_A": "a=b", "OTLP_HEADERS_TEAM_B": "a=b"}


class Switchable:
    """OTLP endpoint whose answer can be changed while the test runs."""

    def __init__(self):
        self.code = 401
        srv = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(srv.code)
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.port = free_port()
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def events(monkeypatch):
    out = []
    monkeypatch.setattr(pipelines, "log", lambda sev, ev, **f: out.append({"severity": sev, "event": ev, **f}))
    logging.disable(logging.CRITICAL)        # the exporter's own error lines
    yield out
    logging.disable(logging.NOTSET)


def test_export_status_records_http_code_and_logs_only_changes(events):
    """Guards the best-effort hook into the exporter's internal HTTP client."""
    ep = Switchable()
    cfg = config.from_dict(yaml.safe_load(open(os.path.join(ROOT, "config.example.yaml"))), ENV)
    tenant = cfg.tenants["team-a"]
    tenant.otlp_endpoint = f"http://127.0.0.1:{ep.port}"
    pl = pipelines.TenantPipeline(cfg, tenant, pipelines.AlertGauge(), with_alert_gauge=False,
                                  with_self_metrics=False)
    try:
        pl.emit_logs("logs_query", 1, 2)
        st = pl.export_status("logs")
        assert (st["ok"], st["status_code"]) == (False, 401) and "Unauthorized" in (st["reason"] or "")
        pl.emit_logs("logs_query", 2, 2)                           # still failing: no new event
        ep.code = 200
        pl.emit_logs("logs_query", 3, 2)
        assert pl.export_status("logs")["ok"] is True
        pl.emit_trace(4, 2)                                        # first success of a signal: silent
    finally:
        pl.shutdown()
        ep.server.shutdown()
    changes = [(e["signal"], e["ok"], e.get("status_code")) for e in events if e["event"] == "export_status"]
    assert changes == [("logs", False, 401), ("logs", True, None)]
    assert pl.export_status("traces")["ok"] is True


def test_healthz_reports_a_stuck_scheduler(monkeypatch):
    monkeypatch.setattr(checks_mod, "log", lambda *a, **k: None)
    cfg = config.from_dict(yaml.safe_load(open(os.path.join(ROOT, "config.example.yaml"))), ENV)
    c = checks_mod.Checks(cfg, Telemetry())
    port = free_port()
    srv = ThreadingHTTPServer(("127.0.0.1", port), app.make_handler(c, cfg, Telemetry()))
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def get():
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    try:
        assert get()[0] == 200                                     # not started yet: healthy
        c.tick(time.time())
        assert get()[0] == 200
        c.last_tick -= app.TICK_STALE_SECONDS + 1                  # loop stopped ticking
        code, body = get()
        assert code == 503 and body["healthy"] is False
    finally:
        srv.shutdown()
        c.pool.shutdown()
