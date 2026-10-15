"""Checks, one per (promise, tenant) per cycle.

Alert loops  (metrics_alert, logs_alert): write a signal carrying probe_id; a
    Grafana rule fires and its webhook may land on ANY replica, which validates
    it statelessly (probe_id is the cycle start, so latency = now - probe_id).
Query checks (logs_query, traces_query): write `count` items, then read them
    back through Grafana until all are visible or the deadline passes.

Every check produces exactly one `check_started` (sender) and, if it gets that
far, one `check_result`. GCP alerts on the ABSENCE of ok results, so any
failure that produces silence is still caught.
"""

from __future__ import annotations

import string
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .config import Config, Promise, Tenant
from .grafana import QueryError
from .pipelines import AlertGauge
from .report import Telemetry, log

CLOCK_SKEW_SECONDS = 60
QUERY_LOOKBACK_SECONDS = 60


class Checks:
    def __init__(self, cfg: Config, telemetry: Telemetry, gauge: AlertGauge | None = None,
                 pipelines: dict | None = None, grafana=None,
                 clock=time.time, stop: threading.Event | None = None, max_workers: int = 16):
        self.cfg, self.telemetry = cfg, telemetry
        self.gauge = gauge or AlertGauge()
        self.pipelines = pipelines or {}
        self.grafana = grafana
        self.clock = clock
        self.stop = stop or threading.Event()
        self.pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="check")
        self.lock = threading.Lock()
        self.current_cycle = 0
        self.seen: dict[tuple, float] = {}
        self.stats = {"started": 0, "ok": 0, "failed": 0}

    # ----------------------------------------------------------- reporting --

    def _base(self, p: Promise, tenant: str, replica: str) -> dict:
        return {"probe": self.cfg.probe_name, "promise": p.name, "signal": p.signal,
                "tenant": tenant, "replica": replica}

    def _started(self, p: Promise, t: Tenant, probe_id: int) -> None:
        with self.lock:
            self.stats["started"] += 1
        log("INFO", "check_started", probe_id=probe_id, **self._base(p, t.name, self.cfg.replica))
        self.telemetry.started(p.name, t.name)

    def _result(self, p: Promise, tenant: str, origin: str, probe_id, ok: bool,
                reason=None, latency=None, **extra) -> None:
        with self.lock:
            self.stats["ok" if ok else "failed"] += 1
        fields = {**self._base(p, tenant, origin), "received_by": self.cfg.replica,
                  "probe_id": probe_id, "ok": ok, **extra}
        if reason:
            fields["reason"] = reason
        if latency is not None:
            fields["latency_seconds"] = round(latency, 3)
        log("INFO" if ok else "WARNING", "check_result", **fields)
        self.telemetry.result(p.name, tenant, origin, ok, reason, latency)

    # ---------------------------------------------------------------- send --

    def tick(self, now: float) -> None:
        cycle = int(now - (now % self.cfg.period_seconds))
        into = now - cycle
        new_cycle = False
        with self.lock:
            if cycle != self.current_cycle:
                self.current_cycle, new_cycle = cycle, True

        if new_cycle:
            for p, t in self.cfg.tenant_promises():
                # Start late (process restart) only if the check can still finish in this cycle.
                if p.kind == "alert" and into >= p.firing_seconds:
                    continue
                if p.kind == "query" and into > self.cfg.period_seconds - p.deadline_seconds:
                    continue
                self._started(p, t, cycle)
                if p.name == "logs_alert":
                    self.pool.submit(self._emit_logs_alert, p, t, cycle)
                elif p.kind == "query":
                    self.pool.submit(self._run_query, p, t, cycle)
            m = self.cfg.promises.get("metrics_alert")
            if m and into < m.firing_seconds:
                self.gauge.set(1, cycle)

        m = self.cfg.promises.get("metrics_alert")
        state, pid = self.gauge.read()
        if m and state == 1 and now - pid >= m.firing_seconds:
            self.gauge.set(0, pid)
            log("INFO", "probe_cleared", probe=self.cfg.probe_name, promise=m.name,
                replica=self.cfg.replica, probe_id=pid)

        horizon = now - 2 * self.cfg.period_seconds
        with self.lock:
            for k, ts in list(self.seen.items()):
                if ts < horizon:
                    del self.seen[k]

    def _emit_logs_alert(self, p: Promise, t: Tenant, probe_id: int) -> None:
        try:
            self.pipelines[t.name].emit_logs("logs_alert", probe_id, 1)
        except Exception as e:  # noqa: BLE001 - exporter errors must not kill the loop
            log("ERROR", "emit_error", error=f"{type(e).__name__}: {e}"[:300],
                **self._base(p, t.name, self.cfg.replica))

    # --------------------------------------------------------- query checks --

    def _run_query(self, p: Promise, t: Tenant, probe_id: int) -> None:
        started = self.clock()
        vars_ = {"service_name": self.cfg.service_name, "probe": self.cfg.probe_name,
                 "probe_id": str(probe_id), "replica": self.cfg.replica, "tenant": t.name}
        try:
            if p.signal == "logs":
                self.pipelines[t.name].emit_logs("logs_query", probe_id, p.count)
            else:
                vars_["trace_id"] = self.pipelines[t.name].emit_trace(probe_id, p.count)
        except Exception as e:  # noqa: BLE001
            return self._result(p, t.name, self.cfg.replica, probe_id, False, "emit_error",
                                error=f"{type(e).__name__}: {e}"[:300])

        query = string.Template(p.query).safe_substitute(vars_)
        deadline = started + p.deadline_seconds
        observed, last_error = 0, None
        while True:
            if self.stop.wait(p.poll_interval_seconds):
                return  # shutting down: leave no result; GCP treats it as absence
            now = self.clock()
            try:
                if p.signal == "logs":
                    observed = self.grafana.loki_count(t.datasources["loki"], query,
                                                       started - QUERY_LOOKBACK_SECONDS,
                                                       now + QUERY_LOOKBACK_SECONDS)
                else:
                    observed = self.grafana.tempo_span_count(t.datasources["tempo"], query) or 0
                last_error = None
            except QueryError as e:
                last_error = str(e)[:300]
            if observed >= p.count:
                return self._result(p, t.name, self.cfg.replica, probe_id, True, None,
                                    now - started, expected=p.count, observed=observed,
                                    **({"trace_id": vars_["trace_id"]} if "trace_id" in vars_ else {}))
            if now >= deadline:
                break
        reason = "incomplete" if observed > 0 else ("query_error" if last_error else "not_found")
        extra = {"expected": p.count, "observed": observed}
        if last_error:
            extra["error"] = last_error
        if "trace_id" in vars_:
            extra["trace_id"] = vars_["trace_id"]
        self._result(p, t.name, self.cfg.replica, probe_id, False, reason, **extra)

    # ------------------------------------------------------- alert receiver --

    def handle_alert(self, alert: dict, now: float) -> None:
        labels = alert.get("labels") or {}
        if labels.get("probe") not in (None, self.cfg.probe_name):
            return
        p = self.cfg.promises.get(labels.get("promise", ""))
        tenant = labels.get("tenant", "")
        status = alert.get("status", "unknown")
        if not p or p.kind != "alert":
            return log("WARNING", "webhook_ignored", reason="unknown_promise",
                       promise=str(labels.get("promise"))[:64], received_by=self.cfg.replica)
        if tenant not in p.tenants:
            return log("WARNING", "webhook_ignored", reason="unknown_tenant", promise=p.name,
                       tenant=tenant[:64], received_by=self.cfg.replica)
        origin = str(labels.get("replica") or labels.get("probe_replica") or "unknown")[:64]

        raw_id = (alert.get("annotations") or {}).get("probe_id", "")
        try:
            pid = int(float(raw_id))
        except (TypeError, ValueError):
            if status == "firing":
                self._result(p, tenant, origin, None, False, "missing_or_bad_probe_id",
                             raw_probe_id=str(raw_id)[:64])
            return
        if status not in ("firing", "resolved"):
            return log("WARNING", "webhook_ignored", reason="unknown_status", status=str(status)[:32],
                       **self._base(p, tenant, origin))
        if pid % self.cfg.period_seconds != 0:
            # e.g. a lossy "1.76054e+09" rendering - never count it as success
            if status == "firing":
                self._result(p, tenant, origin, pid, False, "probe_id_not_aligned")
            return

        reference = pid if status == "firing" else pid + p.firing_seconds
        latency = now - reference
        if latency < -CLOCK_SKEW_SECONDS:
            reason = "from_future"
        elif latency > p.deadline_seconds:
            reason = "late"
        else:
            reason = None

        if status == "resolved":
            return log("INFO", "alert_resolved", probe_id=pid, received_by=self.cfg.replica,
                       latency_seconds=round(latency, 3), ok=reason is None,
                       **({"reason": reason} if reason else {}), **self._base(p, tenant, origin))
        if reason:
            return self._result(p, tenant, origin, pid, False, reason, latency)

        key = (p.name, tenant, origin, pid)
        with self.lock:
            duplicate = key in self.seen
            self.seen.setdefault(key, now)
        if duplicate:
            return log("INFO", "webhook_ignored", reason="duplicate", probe_id=pid,
                       received_by=self.cfg.replica, **self._base(p, tenant, origin))
        self._result(p, tenant, origin, pid, True, None, max(latency, 0.0))

    def snapshot(self) -> dict:
        state, pid = self.gauge.read()
        with self.lock:
            return {"probe": self.cfg.probe_name, "replica": self.cfg.replica,
                    "cycle": self.current_cycle, "metrics_alert_state": state,
                    "metrics_alert_probe_id": pid, **self.stats}

    def shutdown(self) -> None:
        self.stop.set()
        self.pool.shutdown(wait=True, cancel_futures=True)
