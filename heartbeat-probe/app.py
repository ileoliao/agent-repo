"""
heartbeat-probe entry point: one probe instance = one process.

Configuration: YAML file at $PROBE_CONFIG (see config.example.yaml).
Identity:      $PROBE_INSTANCE, one of `instances[].name` in the config.
Run each instance as a single-replica Deployment; run two or more independent
instances (in different zones) for measurer availability and attribution.
"""

from __future__ import annotations

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
TICK_STALE_SECONDS = 60     # the loop ticks every second; this long without one = stuck


def make_handler(checks: Checks, cfg: config_mod.Config, telemetry: Telemetry):
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
                snap = checks.snapshot()
                age = snap["last_tick_age_seconds"]
                stuck = age is not None and age > TICK_STALE_SECONDS
                self._reply(503 if stuck else 200, {**snap, "healthy": not stuck})
            else:
                self._reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/webhook":
                return self._reply(404, {"error": "not found"})
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
            # Always 200 for well-formed requests: a retry could never turn into a verdict.
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
        metrics_tenants = set(cfg.promises["metrics_alert"].tenants) if "metrics_alert" in cfg.promises else set()
        for name, tenant in cfg.tenants.items():
            pl = TenantPipeline(cfg, tenant, gauge, with_alert_gauge=name in metrics_tenants,
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
    log("INFO", "started", instance=cfg.instance, period=cfg.period_seconds,
        tenants=sorted(cfg.tenants), promises=sorted(cfg.promises), port=cfg.listen_port)

    while not stop.is_set():
        checks.tick(time.time())
        stop.wait(1.0)

    server.shutdown()
    checks.shutdown()
    for pl in pipelines.values():
        pl.shutdown()
    log("INFO", "stopped", instance=cfg.instance)
    return 0


if __name__ == "__main__":
    sys.exit(main())
