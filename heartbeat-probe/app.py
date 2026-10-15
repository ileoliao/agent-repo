"""
End-to-end alerting pipeline probe (heartbeat-probe). Multi-replica safe.

Loop (every replica runs it independently):
  1. Every PROBE_PERIOD_SECONDS a new probe starts. probe_id = cycle start
     (epoch seconds, aligned to the period), so every replica derives the same
     clock-based ID and the send time is implied by the ID itself.
  2. For the first PROBE_FIRING_SECONDS of the cycle the gauge
     heartbeat.probe.state{probe, replica} is 1, otherwise 0. The gauge
     heartbeat.probe.id{probe, replica} carries probe_id.
     Metrics go out over OTLP through the normal ingest path
     (Nginx -> OTel Collector -> Mimir).
  3. A Grafana rule (one alert instance per replica) fires while state > 0 and
     echoes probe_id in an annotation; the webhook hits /webhook on ANY replica.
  4. The receiving replica validates the notification statelessly
     (probe_id aligned to the period and within PROBE_TIMEOUT_SECONDS of now),
     computes latency from probe_id, and logs it with the *originating* replica
     taken from the alert labels. No shared state is needed.
  5. Cloud Logging collects stdout; GCP alerts per replica on the absence of
     matched heartbeats (= timeout), absence of probe_sent (= probe down), and
     on latency.

Log events (jsonPayload.event):
  probe_sent       this replica entered the firing phase   (replica = self)
  probe_cleared    this replica left the firing phase      (replica = self)
  alert_received   webhook notification                    (replica = originator)
                   fields: status firing|resolved, matched, latency_seconds, reason, received_by

Self-observability (standard OTel SDK, same OTLP endpoint, for reviewing the
probe in Grafana; GCP stays the independent judge):
  heartbeat.probe.sent              counter   {probe, replica}
  heartbeat.probe.notifications     counter   {probe, replica, received_by, status, matched, reason}
  heartbeat.probe.latency           histogram {probe, replica, status}  (validated only, seconds)
  heartbeat.probe.webhook.rejected  counter   {probe, received_by, reason}

Use stable replica IDs (StatefulSet pod names): GCP absence alerts are per replica.
"""

from __future__ import annotations

import hmac
import json
import os
import signal
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 1 << 20
CLOCK_SKEW_SECONDS = 60


# ---------------------------------------------------------------- config ----

class Config:
    def __init__(self, env=os.environ):
        self.probe_name = env.get("PROBE_NAME", "e2e")
        self.replica = env.get("REPLICA_ID") or env.get("HOSTNAME") or socket.gethostname()
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


# ------------------------------------------------------------- telemetry ----

LATENCY_BUCKETS = [5, 15, 30, 45, 60, 90, 120, 180, 240, 300]


class Telemetry:
    """Self-observability hooks. The no-op base keeps the core logic testable."""

    def sent(self) -> None: ...
    def notification(self, origin, status, matched, reason, latency) -> None: ...
    def rejected(self, reason: str) -> None: ...


class NoopTelemetry(Telemetry):
    pass


class OtelTelemetry(Telemetry):
    """Standard OTel SDK instruments, exported with the probe gauges over the same OTLP endpoint."""

    def __init__(self, meter, cfg: Config):
        self.cfg = cfg
        self._sent = meter.create_counter(
            "heartbeat.probe.sent", unit="{probe}",
            description="Probes started by this replica")
        self._notifications = meter.create_counter(
            "heartbeat.probe.notifications", unit="{notification}",
            description="Grafana webhook notifications handled, by outcome")
        self._latency = meter.create_histogram(
            "heartbeat.probe.latency", unit="s",
            description="End-to-end latency of validated notifications")
        self._rejected = meter.create_counter(
            "heartbeat.probe.webhook.rejected", unit="{request}",
            description="Webhook requests rejected before processing")

    def sent(self) -> None:
        self._sent.add(1, {"probe": self.cfg.probe_name, "replica": self.cfg.replica})

    def notification(self, origin, status, matched, reason, latency) -> None:
        origin = str(origin)[:64]   # value comes from the request; keep cardinality bounded
        status = status if status in ("firing", "resolved") else "other"
        self._notifications.add(1, {
            "probe": self.cfg.probe_name, "replica": origin, "received_by": self.cfg.replica,
            "status": status, "matched": str(matched).lower(), "reason": reason or "none"})
        if latency is not None:
            self._latency.record(latency, {"probe": self.cfg.probe_name, "replica": origin,
                                           "status": status})

    def rejected(self, reason: str) -> None:
        self._rejected.add(1, {"probe": self.cfg.probe_name, "received_by": self.cfg.replica,
                               "reason": reason})


# ----------------------------------------------------------- probe state ----

class Probe:
    """Sender state is per replica; receiving is stateless. Time is injected for tests."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.state = 0
        self.probe_id = 0
        self.seen: dict[tuple, float] = {}   # best-effort local duplicate marker only
        self.counters = {"sent": 0, "received": 0, "matched": 0}
        self.telemetry: Telemetry = NoopTelemetry()

    def tick(self, now: float) -> None:
        cycle_start = int(now - (now % self.cfg.period))
        want_state = 1 if (now - cycle_start) < self.cfg.firing else 0
        base = {"probe": self.cfg.probe_name, "replica": self.cfg.replica}

        with self.lock:
            if want_state == 1 and (self.state == 0 or self.probe_id != cycle_start):
                if self.probe_id != cycle_start:
                    self.counters["sent"] += 1
                    log("INFO", "probe_sent", probe_id=cycle_start, **base)
                    self.telemetry.sent()
                self.state, self.probe_id = 1, cycle_start
            elif want_state == 0 and self.state == 1:
                self.state = 0
                log("INFO", "probe_cleared", probe_id=self.probe_id, **base)

            horizon = now - 2 * self.cfg.period
            for k, t in list(self.seen.items()):
                if t < horizon:
                    del self.seen[k]

    def handle_alert(self, alert: dict, now: float) -> None:
        labels = alert.get("labels") or {}
        if labels.get("probe") not in (None, self.cfg.probe_name):
            return
        status = alert.get("status", "unknown")
        origin = labels.get("replica", "unknown")
        fields = {"probe": self.cfg.probe_name, "replica": origin,
                  "received_by": self.cfg.replica, "status": status}

        raw_id = (alert.get("annotations") or {}).get("probe_id", "")
        try:
            pid = int(float(raw_id))
        except (TypeError, ValueError):
            fields["raw_probe_id"] = str(raw_id)[:64]
            return self._outcome(fields, False, "missing_or_bad_probe_id")
        fields["probe_id"] = pid

        if status not in ("firing", "resolved"):
            return self._outcome(fields, False, "unknown_status")
        if pid % self.cfg.period != 0:
            # e.g. a lossy "1.76054e+09" rendering - never count it as success
            return self._outcome(fields, False, "probe_id_not_aligned")

        # firing is measured from the probe start, resolved from the clear time
        reference = pid if status == "firing" else pid + self.cfg.firing
        latency = now - reference
        if latency < -CLOCK_SKEW_SECONDS:
            return self._outcome(fields, False, "from_future", latency)
        if latency > self.cfg.timeout:
            return self._outcome(fields, False, "late", latency)

        key = (origin, pid, status)
        with self.lock:
            duplicate = key in self.seen
            self.seen.setdefault(key, now)
        if duplicate:
            return self._outcome(fields, False, "duplicate", latency)
        self._outcome(fields, True, None, max(latency, 0.0))

    def _outcome(self, fields: dict, matched: bool, reason, latency=None) -> None:
        """Single exit point: structured log for GCP + OTel metrics for self-review."""
        with self.lock:
            self.counters["received"] += 1
            if matched:
                self.counters["matched"] += 1
        extra = {"matched": matched}
        if reason:
            extra["reason"] = reason
        if latency is not None:
            extra["latency_seconds"] = round(latency, 3)
        severity = "INFO" if matched or reason == "duplicate" else "WARNING"
        log(severity, "alert_received", **extra, **fields)
        self.telemetry.notification(fields["replica"], fields["status"], matched, reason,
                                    latency if matched else None)

    def snapshot(self) -> dict:
        with self.lock:
            return {"probe": self.cfg.probe_name, "replica": self.cfg.replica,
                    "state": self.state, "probe_id": self.probe_id, **self.counters}


# --------------------------------------------------------------- metrics ----

def setup_metrics(probe: Probe, cfg: Config):
    """OTLP/HTTP exporter configured by the standard OTEL_EXPORTER_OTLP_* env vars."""
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.metrics import CallbackOptions, Observation
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
    from opentelemetry.sdk.resources import Resource

    attrs = {"probe": cfg.probe_name, "replica": cfg.replica}

    def observe_state(_: CallbackOptions):
        with probe.lock:
            yield Observation(probe.state, attrs)

    def observe_id(_: CallbackOptions):
        with probe.lock:
            if probe.probe_id:
                yield Observation(probe.probe_id, attrs)

    # Resource.create() also honours OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES.
    base_attrs = {"service.instance.id": cfg.replica}
    if not os.environ.get("OTEL_SERVICE_NAME"):
        base_attrs["service.name"] = "heartbeat-probe"
    resource = Resource.create(base_attrs)
    reader = PeriodicExportingMetricReader(OTLPMetricExporter(),
                                           export_interval_millis=cfg.export_interval * 1000)
    latency_view = View(instrument_name="heartbeat.probe.latency",
                        aggregation=ExplicitBucketHistogramAggregation(LATENCY_BUCKETS))
    provider = MeterProvider(resource=resource, metric_readers=[reader], views=[latency_view])
    meter = provider.get_meter("heartbeat-probe")
    probe.telemetry = OtelTelemetry(meter, cfg)
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
                log("WARNING", "webhook_unauthorized", client=self.client_address[0],
                    received_by=cfg.replica)
                probe.telemetry.rejected("unauthorized")
                return self._reply(401, {"error": "unauthorized"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY_BYTES:
                probe.telemetry.rejected("bad_length")
                return self._reply(400, {"error": "bad length"})
            try:
                payload = json.loads(self.rfile.read(length))
                alerts = payload.get("alerts") or []
            except (ValueError, AttributeError):
                probe.telemetry.rejected("bad_json")
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

    log("INFO", "started", probe=cfg.probe_name, replica=cfg.replica, period=cfg.period,
        firing=cfg.firing, timeout=cfg.timeout, port=cfg.listen_port)
    while not stop.is_set():
        probe.tick(time.time())
        stop.wait(1.0)

    server.shutdown()
    if provider is not None:
        provider.shutdown()
    log("INFO", "stopped", probe=cfg.probe_name, replica=cfg.replica)
    return 0


if __name__ == "__main__":
    sys.exit(main())
