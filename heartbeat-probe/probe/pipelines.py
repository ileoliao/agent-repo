"""One set of standard OTel SDK providers per tenant.

Each tenant has its own OTLP endpoint and credentials, so synthetic data goes
through exactly the ingest path (Nginx, Basic auth, Collector, tenant) that the
tenant's real services use.
"""

from __future__ import annotations

import os
import threading
import time

from opentelemetry._logs import SeverityNumber
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .config import Config, Tenant
from .report import LATENCY_BUCKETS, OtelTelemetry, log


class ExportTracker:
    """Latest OTLP export outcome per signal for one tenant.

    Success/failure comes from the exporters' public return value. The HTTP
    status code and reason come, best effort, from the exporter's internal
    HTTP client (pinned OTel version; a test guards this). Every change of
    state is logged once, so a revoked credential or throttling is visible
    without waiting for checks to fail.
    """

    def __init__(self, tenant: str, instance: str):
        self.tenant, self.instance = tenant, instance
        self.lock = threading.Lock()
        self.state: dict[str, dict] = {}
        self.detail: dict[str, dict] = {}

    def record_detail(self, signal: str, status_code, reason, error) -> None:
        with self.lock:
            self.detail[signal] = {"status_code": status_code,
                                   "reason": str(reason or error or "")[:200] or None}

    def record(self, signal: str, ok: bool) -> None:
        now = time.time()
        with self.lock:
            prev = self.state.get(signal)
            d = {} if ok else dict(self.detail.get(signal) or {})
            if prev is not None and prev["ok"] == ok:
                prev.update(d)
                return
            self.state[signal] = {"ok": ok, "since": now, **d}
        if ok and prev is None:
            return                     # first success: nothing to report
        log("INFO" if ok else "WARNING", "export_status", tenant=self.tenant, signal=signal,
            instance=self.instance, ok=ok, **{k: v for k, v in d.items() if v is not None})

    def status(self, signal: str) -> dict | None:
        with self.lock:
            st = self.state.get(signal)
            return dict(st) if st else None


def _hook_client(exporter, tracker: ExportTracker, signal: str) -> None:
    client = getattr(exporter, "_client", None)
    inner = getattr(client, "export", None)
    if inner is None:
        return

    def export(data):
        r = inner(data)
        tracker.record_detail(signal, getattr(r, "status_code", None), getattr(r, "reason", None),
                              getattr(r, "error", None))
        return r

    client.export = export


def _ok(result) -> bool:
    return getattr(result, "name", "") == "SUCCESS"


class RecordingLogExporter(OTLPLogExporter):
    def __init__(self, tracker: ExportTracker, **kw):
        super().__init__(**kw)
        self._tracker = tracker
        _hook_client(self, tracker, "logs")

    def export(self, batch):
        r = super().export(batch)
        self._tracker.record("logs", _ok(r))
        return r


class RecordingSpanExporter(OTLPSpanExporter):
    def __init__(self, tracker: ExportTracker, **kw):
        super().__init__(**kw)
        self._tracker = tracker
        _hook_client(self, tracker, "traces")

    def export(self, spans):
        r = super().export(spans)
        self._tracker.record("traces", _ok(r))
        return r


class RecordingMetricExporter(OTLPMetricExporter):
    def __init__(self, tracker: ExportTracker, **kw):
        super().__init__(**kw)
        self._tracker = tracker
        _hook_client(self, tracker, "metrics")

    def export(self, metrics_data, timeout_millis: float = 10_000, **kwargs):
        r = super().export(metrics_data, timeout_millis=timeout_millis, **kwargs)
        self._tracker.record("metrics", _ok(r))
        return r


class AlertGauge:
    """Shared state for metrics_alert: what every tenant's gauge reports."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state = 0
        self.probe_id = 0

    def set(self, state: int, probe_id: int) -> None:
        with self.lock:
            self.state, self.probe_id = state, probe_id

    def read(self):
        with self.lock:
            return self.state, self.probe_id


class TenantPipeline:
    def __init__(self, cfg: Config, tenant: Tenant, gauge: AlertGauge, with_alert_gauge: bool,
                 with_self_metrics: bool):
        self.cfg, self.tenant = cfg, tenant
        attrs = {"service.instance.id": cfg.instance, "probe.tenant": tenant.name}
        if not os.environ.get("OTEL_SERVICE_NAME"):
            attrs["service.name"] = cfg.service_name
        resource = Resource.create(attrs)
        base, headers = tenant.otlp_endpoint, tenant.otlp_headers
        self.tracker = ExportTracker(tenant.name, cfg.instance)

        # metrics
        reader = PeriodicExportingMetricReader(
            RecordingMetricExporter(self.tracker, endpoint=f"{base}/v1/metrics", headers=headers),
            export_interval_millis=cfg.export_interval_seconds * 1000)
        view = View(instrument_name="heartbeat.probe.checks.latency",
                    aggregation=ExplicitBucketHistogramAggregation(LATENCY_BUCKETS))
        self.meter_provider = MeterProvider(resource=resource, metric_readers=[reader], views=[view])
        meter = self.meter_provider.get_meter("heartbeat-probe")
        self.telemetry = OtelTelemetry(meter, cfg.instance) if with_self_metrics else None

        if with_alert_gauge:
            gauge_attrs = {"probe_instance": cfg.instance}

            def observe_state(_: CallbackOptions):
                state, _pid = gauge.read()
                yield Observation(state, gauge_attrs)

            def observe_id(_: CallbackOptions):
                _state, pid = gauge.read()
                if pid:
                    yield Observation(pid, gauge_attrs)

            meter.create_observable_gauge("heartbeat.probe.state", callbacks=[observe_state],
                                          description="1 while the metrics alert should fire")
            meter.create_observable_gauge("heartbeat.probe.id", callbacks=[observe_id],
                                          description="Current probe ID (cycle start, epoch seconds)")

        # logs
        self.logger_provider = LoggerProvider(resource=resource)
        self.logger_provider.add_log_record_processor(BatchLogRecordProcessor(
            RecordingLogExporter(self.tracker, endpoint=f"{base}/v1/logs", headers=headers), schedule_delay_millis=1000))
        self.logger = self.logger_provider.get_logger("heartbeat-probe")

        # traces
        self.tracer_provider = TracerProvider(resource=resource)
        self.tracer_provider.add_span_processor(BatchSpanProcessor(
            RecordingSpanExporter(self.tracker, endpoint=f"{base}/v1/traces", headers=headers), schedule_delay_millis=1000))
        self.tracer = self.tracer_provider.get_tracer("heartbeat-probe")

    def emit_logs(self, check: str, probe_id: int, count: int) -> None:
        for seq in range(count):
            self.logger.emit(
                body=f"heartbeat probe {check} {probe_id} {seq + 1}/{count}",
                severity_number=SeverityNumber.INFO, severity_text="INFO",
                attributes={"probe.check": check, "probe.id": probe_id,
                            "probe.instance": self.cfg.instance,
                            "probe.seq": seq + 1, "probe.count": count})
        self.logger_provider.force_flush(5000)

    def emit_trace(self, probe_id: int, span_count: int) -> str:
        """Root span plus span_count-1 children; returns the trace ID (hex)."""
        attrs = {"probe.check": "traces_query", "probe.id": probe_id,
                 "probe.instance": self.cfg.instance, "probe.count": span_count}
        with self.tracer.start_as_current_span("heartbeat-probe", attributes=attrs) as root:
            for i in range(span_count - 1):
                with self.tracer.start_as_current_span(f"heartbeat-probe.child.{i + 1}", attributes=attrs):
                    pass
            trace_id = format(root.get_span_context().trace_id, "032x")
        self.tracer_provider.force_flush(5000)
        return trace_id

    def export_status(self, signal: str) -> dict | None:
        """{"ok", "since", "status_code", "reason"} of the latest export, or None if none yet."""
        return self.tracker.status(signal)

    def shutdown(self) -> None:
        for p in (self.tracer_provider, self.logger_provider, self.meter_provider):
            try:
                p.shutdown()
            except Exception:  # noqa: BLE001 - best effort on exit
                pass
