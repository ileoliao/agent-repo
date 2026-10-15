"""
heartbeat-probe entry point: HTTP webhook receiver + check scheduler.

Configuration: YAML file at $PROBE_CONFIG (see config.example.yaml).
Replica identity: $REPLICA_ID (StatefulSet pod name), else $HOSTNAME.
Run several replicas: checks are per replica, webhook validation is stateless.
"""

from __future__ import annotations

import hmac
import json
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from probe import config as config_mod
from probe.checks import Checks
from probe.grafana import Grafana
from probe.pipelines import AlertGauge, TenantPipeline
from probe.report import Telemetry, log

MAX_BODY_BYTES = 1 << 20


def make_handler(checks: Checks, cfg: config_mod.Config, telemetry: Telemetry):
    expected = f"Bearer {cfg.webhook_token}".encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "heartbeat-probe"

        def log_message(self, *_):  # stdout is reserved for structured logs
            pass

        def _reply(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/healthz":
                self._reply(200, checks.snapshot())
            else:
                self._reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/webhook":
                return self._reply(404, {"error": "not found"})
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected):
                log("WARNING", "webhook_unauthorized", client=self.client_address[0],
                    received_by=cfg.replica)
                telemetry.rejected("unauthorized")
                return self._reply(401, {"error": "unauthorized"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY_BYTES:
                telemetry.rejected("bad_length")
                return self._reply(400, {"error": "bad length"})
            try:
                alerts = json.loads(self.rfile.read(length)).get("alerts") or []
            except (ValueError, AttributeError):
                telemetry.rejected("bad_json")
                return self._reply(400, {"error": "bad json"})
            now = time.time()
            for alert in alerts:
                if isinstance(alert, dict):
                    checks.handle_alert(alert, now)
            self._reply(200, {"ok": True})

    return Handler


def main() -> int:
    try:
        cfg = config_mod.load()
    except (OSError, config_mod.ConfigError) as e:
        log("CRITICAL", "config_error", error=str(e))
        return 2

    gauge = AlertGauge()
    pipelines, telemetry = {}, Telemetry()
    if not cfg.disable_export:
        for name, tenant in cfg.tenants.items():
            pl = TenantPipeline(cfg, tenant, gauge,
                                with_alert_gauge=any(p.name == "metrics_alert" and name in p.tenants
                                                     for p in cfg.promises.values()),
                                with_self_metrics=name == cfg.self_metrics_tenant)
            pipelines[name] = pl
            if pl.telemetry:
                telemetry = pl.telemetry
    grafana = Grafana(cfg.grafana_url, cfg.grafana_token, cfg.grafana_ca_file) if cfg.grafana_url else None

    stop = threading.Event()
    checks = Checks(cfg, telemetry, gauge, pipelines, grafana, stop=stop)
    server = ThreadingHTTPServer(("0.0.0.0", cfg.listen_port), make_handler(checks, cfg, telemetry))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    log("INFO", "started", probe=cfg.probe_name, replica=cfg.replica, period=cfg.period_seconds,
        tenants=sorted(cfg.tenants), promises=sorted(cfg.promises), port=cfg.listen_port)

    while not stop.is_set():
        checks.tick(time.time())
        stop.wait(1.0)

    server.shutdown()
    checks.shutdown()
    for pl in pipelines.values():
        pl.shutdown()
    log("INFO", "stopped", probe=cfg.probe_name, replica=cfg.replica)
    return 0


if __name__ == "__main__":
    sys.exit(main())
