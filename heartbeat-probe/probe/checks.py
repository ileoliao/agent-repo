"""Checks. Every check is owned by the instance that started it, and the owner
produces exactly one verdict (`check_result`) per check:

    emit  ->  observe  ->  verdict (ok, or failed with a reason)

Alert promises (metrics_alert, logs_alert): the owner writes a signal carrying
    probe_id and waits for Grafana's webhook, which is routed to this instance's
    own contact point. Match -> ok; deadline passed -> failed/timeout.
Query promises (logs_query, traces_query): the owner writes `count` items and
    reads them back through Grafana until all are visible or the deadline passes.

If the latest OTLP export for the check's tenant and signal failed (rejected
credential, throttling, unreachable entry point), the verdict is
failed/export_failed with the HTTP status, instead of a less precise
timeout / not_found.

Measurement faults are not platform verdicts:
- A process starts measuring at the NEXT cycle boundary; a cycle that was in
  progress before a restart produces no verdict (void), not a failure.
- On shutdown, pending checks are dropped without a verdict (void).
- Duplicate or unknown webhooks never create a verdict.
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

QUERY_LOOKBACK_SECONDS = 60


class Checks:
    def __init__(self, cfg: Config, telemetry: Telemetry, gauge: AlertGauge | None = None,
                 pipelines: dict | None = None, grafana=None, clock=time.time,
                 stop: threading.Event | None = None, max_workers: int | None = None):
        self.cfg, self.telemetry = cfg, telemetry
        self.gauge = gauge or AlertGauge()
        self.pipelines = pipelines or {}
        self.grafana = grafana
        self.clock = clock
        self.stop = stop or threading.Event()
        # One worker per check, so a slow backend can never queue checks behind each other.
        n_checks = sum(1 for _ in cfg.tenant_promises())
        self.pool = ThreadPoolExecutor(max_workers=max_workers or n_checks + 2, thread_name_prefix="check")
        self.last_tick: float | None = None       # time.monotonic() of the latest tick
        self.lock = threading.Lock()
        self.cycle: int | None = None             # None until the first tick
        self.pending: dict[tuple, float] = {}     # (promise, tenant, probe_id) -> sent_at
        self.stats = {"ok": 0, "failed": 0, "ignored_webhooks": 0}

    # -------------------------------------------------------------- verdict --

    def _result(self, p: Promise, tenant: str, probe_id: int, ok: bool,
                reason: str | None = None, latency: float | None = None, **extra) -> None:
        with self.lock:
            self.stats["ok" if ok else "failed"] += 1
        fields = {"promise": p.name, "signal": p.signal, "tenant": tenant,
                  "instance": self.cfg.instance, "probe_id": probe_id, "ok": ok, **extra}
        if reason:
            fields["reason"] = reason
        if latency is not None:
            fields["latency_seconds"] = round(latency, 3)
        log("INFO" if ok else "WARNING", "check_result", **fields)
        self.telemetry.result(p.name, tenant, ok, reason, latency if ok else None)

    # ------------------------------------------------------------- schedule --

    def _export_failure(self, tenant: str, signal: str) -> dict | None:
        pl = self.pipelines.get(tenant)
        st = pl.export_status(signal) if pl is not None and hasattr(pl, "export_status") else None
        if not st or st.get("ok"):
            return None
        return {"export_status_code": st.get("status_code"), "export_error": st.get("reason")}

    def tick(self, now: float) -> None:
        self.last_tick = time.monotonic()
        cycle = int(now - (now % self.cfg.period_seconds))
        start = False
        with self.lock:
            if self.cycle is None:
                self.cycle = cycle        # joined mid-cycle: wait for the next boundary
                log("INFO", "waiting_for_next_cycle", instance=self.cfg.instance,
                    next_cycle=cycle + self.cfg.period_seconds)
            elif cycle != self.cycle:
                self.cycle, start = cycle, True
        if start:
            self._start_cycle(cycle, now)

        m = self.cfg.promises.get("metrics_alert")
        state, pid = self.gauge.read()
        if m and state == 1 and now - pid >= m.firing_seconds:
            self.gauge.set(0, pid)

        expired = []
        with self.lock:
            for key, sent_at in list(self.pending.items()):
                if now - sent_at > self.cfg.promises[key[0]].deadline_seconds:
                    del self.pending[key]
                    expired.append((key, now - sent_at))
        for (promise, tenant, pid), waited in expired:
            p = self.cfg.promises[promise]
            ef = self._export_failure(tenant, p.signal)
            self._result(p, tenant, pid, False, "export_failed" if ef else "timeout",
                         waited_seconds=round(waited, 3), **(ef or {}))

    def _start_cycle(self, cycle: int, now: float) -> None:
        checks = list(self.cfg.tenant_promises())
        log("INFO", "cycle_started", instance=self.cfg.instance, probe_id=cycle, checks=len(checks))
        if "metrics_alert" in self.cfg.promises:
            self.gauge.set(1, cycle)
        for p, t in checks:
            if p.kind == "alert":
                with self.lock:
                    self.pending[(p.name, t.name, cycle)] = now
                if p.name == "logs_alert":
                    self.pool.submit(self._emit_logs_alert, p, t, cycle)
            else:
                self.pool.submit(self._run_query, p, t, cycle)

    def _emit_logs_alert(self, p: Promise, t: Tenant, probe_id: int) -> None:
        try:
            self.pipelines[t.name].emit_logs("logs_alert", probe_id, 1)
            reason, extra = ("export_failed", ef) if (ef := self._export_failure(t.name, "logs")) else (None, {})
        except Exception as e:  # noqa: BLE001 - exporter errors must not kill the loop
            reason, extra = "emit_error", {"error": f"{type(e).__name__}: {e}"[:300]}
        if reason:
            with self.lock:
                owned = self.pending.pop((p.name, t.name, probe_id), None) is not None
            if owned:
                self._result(p, t.name, probe_id, False, reason, **extra)

    # --------------------------------------------------------- query checks --

    def _run_query(self, p: Promise, t: Tenant, probe_id: int) -> None:
        started = self.clock()
        vars_ = {"service_name": self.cfg.service_name, "probe_id": str(probe_id),
                 "instance": self.cfg.instance, "tenant": t.name}
        try:
            if p.signal == "logs":
                self.pipelines[t.name].emit_logs("logs_query", probe_id, p.count)
            else:
                vars_["trace_id"] = self.pipelines[t.name].emit_trace(probe_id, p.count)
        except Exception as e:  # noqa: BLE001
            return self._result(p, t.name, probe_id, False, "emit_error",
                                error=f"{type(e).__name__}: {e}"[:300])
        ef = self._export_failure(t.name, p.signal)
        if ef:   # the write itself was rejected: no point polling until the deadline
            return self._result(p, t.name, probe_id, False, "export_failed", expected=p.count, **ef)
        extra = {"expected": p.count}
        if "trace_id" in vars_:
            extra["trace_id"] = vars_["trace_id"]

        query = string.Template(p.query).safe_substitute(vars_)
        deadline = started + p.deadline_seconds
        observed, last_error = 0, None
        while True:
            if self.stop.wait(p.poll_interval_seconds):
                return  # shutting down: void, no verdict
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
            if observed >= p.count and now - started <= p.deadline_seconds:
                return self._result(p, t.name, probe_id, True, None, now - started,
                                    observed=observed, **extra)
            if now >= deadline:
                break
        reason = "incomplete" if observed > 0 else ("query_error" if last_error else "not_found")
        if last_error:
            extra["error"] = last_error
        self._result(p, t.name, probe_id, False, reason, observed=observed, **extra)

    # ------------------------------------------------------- alert receiver --

    def handle_alert(self, alert: dict, now: float) -> None:
        """Only a webhook that matches one of THIS instance's pending checks counts.
        The webhook is unauthenticated (cluster-internal); restrict who can reach it
        with a NetworkPolicy if other workloads share the cluster."""
        labels = alert.get("labels") or {}
        if alert.get("status") != "firing":
            return
        why = None
        inst = labels.get("probe_instance")
        p = self.cfg.promises.get(labels.get("promise", ""))
        tenant = labels.get("tenant", "")
        raw_id = (alert.get("annotations") or {}).get("probe_id", "")
        try:
            pid = int(float(raw_id))
        except (TypeError, ValueError):
            pid = None

        if inst != self.cfg.instance:
            why = "other_instance"      # misrouted contact point
        elif not p or p.kind != "alert" or tenant not in p.tenants:
            why = "unknown_promise_or_tenant"
        elif pid is None:
            why = "bad_probe_id"
        else:
            with self.lock:
                sent_at = self.pending.pop((p.name, tenant, pid), None)
            if sent_at is None:
                why = "unmatched"       # duplicate, after timeout, or lossy probe_id
            elif now - sent_at > p.deadline_seconds:
                return self._result(p, tenant, pid, False, "timeout", waited_seconds=round(now - sent_at, 3))
            else:
                return self._result(p, tenant, pid, True, None, now - sent_at)

        with self.lock:
            self.stats["ignored_webhooks"] += 1
        log("INFO", "webhook_ignored", reason=why, instance=self.cfg.instance,
            label_instance=str(inst)[:64], promise=str(labels.get("promise"))[:64],
            tenant=str(tenant)[:64], probe_id=pid if pid is not None else str(raw_id)[:64])
        self.telemetry.ignored(why)

    # ---------------------------------------------------------------- misc --

    def snapshot(self) -> dict:
        state, pid = self.gauge.read()
        with self.lock:
            age = None if self.last_tick is None else round(time.monotonic() - self.last_tick, 1)
            return {"instance": self.cfg.instance, "cycle": self.cycle, "last_tick_age_seconds": age,
                    "pending_alert_checks": len(self.pending),
                    "metrics_alert_state": state, "metrics_alert_probe_id": pid, **self.stats}

    def shutdown(self) -> None:
        self.stop.set()
        self.pool.shutdown(wait=True, cancel_futures=True)
