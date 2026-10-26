"""Two outputs, kept in one place so they never disagree:

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
    """No-op base; OtelTelemetry implements it. Tests subclass it to record calls."""

    def result(self, promise: str, tenant: str, ok: bool, reason, latency) -> None: ...
    def ignored(self, reason: str) -> None: ...
    def rejected(self, reason: str) -> None: ...


class OtelTelemetry(Telemetry):
    def __init__(self, meter, instance: str):
        self.instance = instance
        self._results = meter.create_counter(
            "heartbeat.probe.checks", unit="{check}",
            description="Check verdicts, by promise, tenant, outcome and reason")
        self._latency = meter.create_histogram(
            "heartbeat.probe.checks.latency", unit="s",
            description="Latency of passed checks")
        self._ignored = meter.create_counter(
            "heartbeat.probe.webhook.ignored", unit="{alert}",
            description="Authenticated webhook alerts that matched no pending check")
        self._rejected = meter.create_counter(
            "heartbeat.probe.webhook.rejected", unit="{request}",
            description="Webhook requests rejected before processing")

    def result(self, promise, tenant, ok, reason, latency):
        self._results.add(1, {"probe_instance": self.instance, "promise": promise, "tenant": tenant,
                              "ok": str(bool(ok)).lower(), "reason": reason or "none"})
        if ok and latency is not None:
            self._latency.record(latency, {"probe_instance": self.instance, "promise": promise,
                                           "tenant": tenant})

    def ignored(self, reason):
        self._ignored.add(1, {"probe_instance": self.instance, "reason": reason})

    def rejected(self, reason):
        self._rejected.add(1, {"probe_instance": self.instance, "reason": reason})
