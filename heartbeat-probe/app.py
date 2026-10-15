"""
End-to-end alerting pipeline probe (heartbeat-probe).

Loop:
  1. Every PROBE_PERIOD_SECONDS a new probe starts. For the first
     PROBE_FIRING_SECONDS of the cycle the gauge heartbeat.probe.state is 1,
     otherwise 0. The gauge heartbeat.probe.id carries the probe ID (cycle
     start, epoch seconds) so Grafana can echo it back.
  2. Metrics go out over OTLP through the normal ingest path
     (Nginx -> OTel Collector -> Mimir).
  3. A Grafana alert rule fires while state > 0 and puts the probe ID into an
     annotation; the webhook contact point POSTs it back to /webhook.
  4. This service pairs the firing (and resolved) notification with the probe
     it sent and writes one structured JSON log line per event to stdout.
     Cloud Logging picks these up; GCP alerts on absence / mismatch / latency.

Log events (jsonPayload.event):
  probe_sent       probe entered firing phase
  probe_cleared    probe left firing phase
  alert_received   webhook notification (status firing|resolved, matched, latency_seconds)
  probe_timeout    no matching firing notification within PROBE_TIMEOUT_SECONDS
  resolve_timeout  no matching resolved notification within PROBE_TIMEOUT_SECONDS

Run exactly ONE replica: the probe state is in memory.
"""

from __future__ import annotations

import hmac
import json
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 1 << 20


# ---------------------------------------------------------------- config ----

class Config:
    def __init__(self, env=os.environ):
        self.probe_name = env.get("PROBE_NAME", "e2e")
        self.period = int(env.get("PROBE_PERIOD_SECONDS", "300"))
        self.firing = int(env.get("PROBE_FIRING_SECONDS", "120"))
        self.timeout = int(env.get("PROBE_TIMEOUT_SECONDS", "300"))
        self.listen_port = int(env.get("LISTEN_PORT", "8080"))
        self.webhook_token = env.get("WEBHOOK_TOKEN", "")
        self.export_interval = int(env.get("METRIC_EXPORT_INTERVAL_SECONDS", "15"))
        self.disable_export = env.get("PROBE_DISABLE_EXPORT", "") == "1"

        if not 0 < self.firing < self.period:
            raise ValueError("need 0 < PROBE_FIRING_SECONDS < PROBE_PERIOD_SECONDS")
        if not self.webhook_token:
            raise ValueError("WEBHOOK_TOKEN must be set")


# --------------------------------------------------------------- logging ----

_log_lock = threading.Lock()


def log(severity: str, event: str, **fields) -> None:
    """One JSON object per line; Cloud Logging maps severity/message/time."""
    record = {
        "severity": severity,
        "event": event,
        "message": event,
        "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        **fields,
    }
    line = json.dumps(record, ensure_ascii=False)
    with _log_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# ----------------------------------------------------------- probe state ----

class Probe:
    """Pure state machine; time is passed in so it can be tested."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.state = 0
        self.probe_id = 0
        self.awaiting_fire: dict[int, float] = {}      # probe_id -> sent_at
        self.awaiting_resolve: dict[int, float] = {}   # probe_id -> cleared_at
        self.done_fire: dict[int, float] = {}          # matched ids, for duplicate detection
        self.counters = {"sent": 0, "matched": 0, "timeouts": 0}

    # Called about once per second by the driver loop.
    def tick(self, now: float) -> None:
        cycle_start = int(now - (now % self.cfg.period))
        want_state = 1 if (now - cycle_start) < self.cfg.firing else 0

        with self.lock:
            if want_state == 1 and (self.state == 0 or self.probe_id != cycle_start):
                self.state = 1
                self.probe_id = cycle_start
                if cycle_start not in self.awaiting_fire and cycle_start not in self.done_fire:
                    self.awaiting_fire[cycle_start] = now
                    self.counters["sent"] += 1
                    log("INFO", "probe_sent", probe=self.cfg.probe_name, probe_id=cycle_start)
            elif want_state == 0 and self.state == 1:
                self.state = 0
                self.awaiting_resolve[self.probe_id] = now
                log("INFO", "probe_cleared", probe=self.cfg.probe_name, probe_id=self.probe_id)

            for pid, sent_at in list(self.awaiting_fire.items()):
                if now - sent_at > self.cfg.timeout:
                    del self.awaiting_fire[pid]
                    self.counters["timeouts"] += 1
                    log("ERROR", "probe_timeout", probe=self.cfg.probe_name, probe_id=pid,
                        waited_seconds=round(now - sent_at, 1))

            for pid, cleared_at in list(self.awaiting_resolve.items()):
                if now - cleared_at > self.cfg.timeout:
                    del self.awaiting_resolve[pid]
                    log("WARNING", "resolve_timeout", probe=self.cfg.probe_name, probe_id=pid,
                        waited_seconds=round(now - cleared_at, 1))

            horizon = now - 4 * self.cfg.period
            for pid, t in list(self.done_fire.items()):
                if t < horizon:
                    del self.done_fire[pid]

    def handle_alert(self, alert: dict, now: float) -> None:
        labels = alert.get("labels") or {}
        if labels.get("probe") not in (None, self.cfg.probe_name):
            return
        status = alert.get("status", "unknown")
        raw_id = (alert.get("annotations") or {}).get("probe_id", "")
        try:
            pid = int(float(raw_id))
        except (TypeError, ValueError):
            log("WARNING", "alert_received", probe=self.cfg.probe_name, status=status,
                matched=False, reason="missing_or_bad_probe_id", raw_probe_id=str(raw_id)[:64])
            return

        with self.lock:
            if status == "firing":
                if pid in self.awaiting_fire:
                    sent_at = self.awaiting_fire.pop(pid)
                    self.done_fire[pid] = now
                    self.counters["matched"] += 1
                    log("INFO", "alert_received", probe=self.cfg.probe_name, status=status,
                        probe_id=pid, matched=True, latency_seconds=round(now - sent_at, 3))
                else:
                    reason = "duplicate" if pid in self.done_fire else "unknown_or_late"
                    log("WARNING", "alert_received", probe=self.cfg.probe_name, status=status,
                        probe_id=pid, matched=False, reason=reason)
            elif status == "resolved":
                if pid in self.awaiting_resolve:
                    cleared_at = self.awaiting_resolve.pop(pid)
                    log("INFO", "alert_received", probe=self.cfg.probe_name, status=status,
                        probe_id=pid, matched=True, latency_seconds=round(now - cleared_at, 3))
                else:
                    log("WARNING", "alert_received", probe=self.cfg.probe_name, status=status,
                        probe_id=pid, matched=False, reason="unknown_or_late")

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "probe": self.cfg.probe_name,
                "state": self.state,
                "probe_id": self.probe_id,
                "awaiting_fire": sorted(self.awaiting_fire),
                "awaiting_resolve": sorted(self.awaiting_resolve),
                **self.counters,
            }


# --------------------------------------------------------------- metrics ----

def setup_metrics(probe: Probe, cfg: Config):
    """OTLP/HTTP exporter configured by the standard OTEL_EXPORTER_OTLP_* env vars."""
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.metrics import CallbackOptions, Observation
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource

    attrs = {"probe": cfg.probe_name}

    def observe_state(_: CallbackOptions):
        with probe.lock:
            yield Observation(probe.state, attrs)

    def observe_id(_: CallbackOptions):
        with probe.lock:
            if probe.probe_id:
                yield Observation(probe.probe_id, attrs)

    resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "heartbeat-probe")})
    reader = PeriodicExportingMetricReader(OTLPMetricExporter(),
                                           export_interval_millis=cfg.export_interval * 1000)
    provider = MeterProvider(resource=resource, metric_readers=[reader])
    meter = provider.get_meter("heartbeat-probe")
    meter.create_observable_gauge("heartbeat.probe.state", callbacks=[observe_state],
                                  description="1 while the probe asks the alert to fire, else 0")
    meter.create_observable_gauge("heartbeat.probe.id", callbacks=[observe_id],
                                  description="Current probe ID (cycle start, epoch seconds)")
    return provider


# ------------------------------------------------------------------ http ----

def make_handler(probe: Probe, cfg: Config):
    expected = f"Bearer {cfg.webhook_token}".encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "heartbeat-probe"

        def log_message(self, *_):  # keep stdout for structured logs only
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
                self._reply(200, probe.snapshot())
            else:
                self._reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/webhook":
                return self._reply(404, {"error": "not found"})
            auth = self.headers.get("Authorization", "").encode()
            if not hmac.compare_digest(auth, expected):
                log("WARNING", "webhook_unauthorized", client=self.client_address[0])
                return self._reply(401, {"error": "unauthorized"})
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                return self._reply(400, {"error": "bad length"})
            try:
                payload = json.loads(self.rfile.read(length))
                alerts = payload.get("alerts") or []
            except (ValueError, AttributeError):
                return self._reply(400, {"error": "bad json"})
            now = time.time()
            for alert in alerts:
                if isinstance(alert, dict):
                    probe.handle_alert(alert, now)
            self._reply(200, {"ok": True})

    return Handler


# ------------------------------------------------------------------ main ----

def main() -> int:
    try:
        cfg = Config()
    except ValueError as e:
        log("CRITICAL", "config_error", error=str(e))
        return 2

    probe = Probe(cfg)
    provider = None if cfg.disable_export else setup_metrics(probe, cfg)

    server = ThreadingHTTPServer(("0.0.0.0", cfg.listen_port), make_handler(probe, cfg))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    log("INFO", "started", probe=cfg.probe_name, period=cfg.period, firing=cfg.firing,
        timeout=cfg.timeout, port=cfg.listen_port)
    while not stop.is_set():
        probe.tick(time.time())
        stop.wait(1.0)

    server.shutdown()
    if provider is not None:
        provider.shutdown()
    log("INFO", "stopped", probe=cfg.probe_name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
