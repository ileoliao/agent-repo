"""Two outputs for every check, kept in one place so they never disagree:

* structured JSON on stdout -> Cloud Logging (the independent judge)
* OTel self-metrics        -> your own stack (for review only)
"""

from __future__ import annotations

import json
import sys
import threading
from datetime import datetime, timezone

LATENCY_BUCKETS = [5, 15, 30, 45, 60, 90, 120, 180, 240, 300]

_lock = threading.Lock()


def log(severity: str, event: str, **fields) -> None:
    record = {
        "severity": severity,
        "event": event,
        "message": event,
        "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        **fields,
    }
    line = json.dumps(record, ensure_ascii=False)
    with _lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


class Telemetry:
    """No-op base; OtelTelemetry implements it. Tests can subclass to record calls."""

    def started(self, promise: str, tenant: str) -> None: ...
    def result(self, promise: str, tenant: str, origin: str, ok: bool, reason, latency) -> None: ...
    def rejected(self, reason: str) -> None: ...


class OtelTelemetry(Telemetry):
    def __init__(self, meter, probe_name: str, replica: str):
        self.probe, self.replica = probe_name, replica
        self._started = meter.create_counter(
            "heartbeat.probe.checks.started", unit="{check}",
            description="Checks started by this replica")
        self._results = meter.create_counter(
            "heartbeat.probe.checks.results", unit="{check}",
            description="Check outcomes, by promise, tenant and reason")
        self._latency = meter.create_histogram(
            "heartbeat.probe.checks.latency", unit="s",
            description="Latency of successful checks")
        self._rejected = meter.create_counter(
            "heartbeat.probe.webhook.rejected", unit="{request}",
            description="Webhook requests rejected before processing")

    def started(self, promise, tenant):
        self._started.add(1, {"probe": self.probe, "promise": promise, "tenant": tenant,
                              "replica": self.replica})

    def result(self, promise, tenant, origin, ok, reason, latency):
        attrs = {"probe": self.probe, "promise": promise, "tenant": tenant,
                 "replica": str(origin)[:64], "received_by": self.replica,
                 "ok": str(bool(ok)).lower(), "reason": reason or "none"}
        self._results.add(1, attrs)
        if ok and latency is not None:
            self._latency.record(latency, {"probe": self.probe, "promise": promise,
                                           "tenant": tenant, "replica": str(origin)[:64]})

    def rejected(self, reason):
        self._rejected.add(1, {"probe": self.probe, "received_by": self.replica, "reason": reason})
