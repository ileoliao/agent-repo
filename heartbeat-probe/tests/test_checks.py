import os
import threading

import pytest
import yaml

from probe import checks as checks_mod
from probe import config
from probe.grafana import QueryError, _count_spans
from probe.report import Telemetry

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {"GRAFANA_TOKEN": "g", "OTLP_HEADERS_TEAM_A": "a=b", "OTLP_HEADERS_TEAM_B": "a=c"}
T0 = 1_760_538_000  # aligned to 300 s


def load(instance="e2e-a", promises=None, tenants=None):
    with open(os.path.join(ROOT, "config.example.yaml")) as f:
        raw = yaml.safe_load(f)
    if promises:
        raw["promises"] = {k: v for k, v in raw["promises"].items() if k in promises}
    if tenants:
        raw["tenants"] = [t for t in raw["tenants"] if t["name"] in tenants]
    return config.from_dict(raw, {**ENV, "PROBE_INSTANCE": instance})


@pytest.fixture
def logs(monkeypatch):
    out = []
    monkeypatch.setattr(checks_mod, "log", lambda sev, ev, **f: out.append({"severity": sev, "event": ev, **f}))
    return out


class RecTelemetry(Telemetry):
    def __init__(self):
        self.calls = []

    def result(self, promise, tenant, ok, reason, latency):
        self.calls.append(("result", promise, tenant, ok, reason))

    def ignored(self, reason):
        self.calls.append(("ignored", reason))


class FakePipeline:
    def __init__(self, fail=False, export=None):
        self.logs, self.traces, self.fail = [], [], fail
        self.export = export or {}          # signal -> export status dict

    def export_status(self, signal):
        return self.export.get(signal)

    def emit_logs(self, check, probe_id, count):
        if self.fail:
            raise ConnectionError("collector down")
        self.logs.append((check, probe_id, count))

    def emit_trace(self, probe_id, count):
        self.traces.append((probe_id, count))
        return "ab" * 16


def verdicts(logs, **match):
    return [l for l in logs if l["event"] == "check_result" and all(l.get(k) == v for k, v in match.items())]


def ignored(logs):
    return [l["reason"] for l in logs if l["event"] == "webhook_ignored"]


def alert(pid, promise="metrics_alert", tenant="team-a", instance="e2e-a", status="firing"):
    return {"status": status, "labels": {"promise": promise, "tenant": tenant, "probe_instance": instance},
            "annotations": {"probe_id": str(pid)}}


def metrics_only(instance="e2e-a", tel=None):
    """An instance that has already passed its first (skipped) tick."""
    c = checks_mod.Checks(load(instance, ["metrics_alert"], ["team-a"]), tel or RecTelemetry())
    c.tick(T0 - 1)       # joins mid-cycle: waits
    return c


# ------------------------------------------- the four accuracy scenarios ----
# Previously: duplicates counted twice, a duplicate hid a failure, and a restart
# counted as a failure. Now every check yields exactly one verdict from its owner.

def test_scenario_normal(logs):
    c = metrics_only()
    c.tick(T0)
    c.handle_alert(alert(T0), T0 + 40)
    assert [(v["ok"], v["latency_seconds"]) for v in verdicts(logs)] == [(True, 40)]


def test_scenario_duplicate_webhook_counts_once(logs):
    c = metrics_only()
    c.tick(T0)
    c.handle_alert(alert(T0), T0 + 40)
    c.handle_alert(alert(T0), T0 + 41)
    assert len(verdicts(logs)) == 1 and ignored(logs) == ["unmatched"]


def test_scenario_duplicate_cannot_hide_a_failure(logs):
    c = metrics_only()
    c.tick(T0)                                   # cycle A: webhook never arrives
    c.tick(T0 + 181)                             # deadline 180 s passed
    c.tick(T0 + 300)                             # cycle B
    c.handle_alert(alert(T0 + 300), T0 + 340)
    c.handle_alert(alert(T0 + 300), T0 + 341)    # duplicate
    assert [(v["probe_id"], v["ok"], v.get("reason")) for v in verdicts(logs)] == [
        (T0, False, "timeout"), (T0 + 300, True, None)]


def test_scenario_restart_mid_cycle_is_void_not_failure(logs):
    old = metrics_only()
    old.tick(T0)                                 # started cycle A ...
    old.shutdown()                               # ... then killed: no verdict
    new = checks_mod.Checks(load("e2e-a", ["metrics_alert"], ["team-a"]), RecTelemetry())
    new.tick(T0 + 30)                            # same instance, fresh memory: waits
    new.handle_alert(alert(T0), T0 + 60)         # webhook for the old process's probe
    new.tick(T0 + 200)
    assert verdicts(logs) == [] and ignored(logs) == ["unmatched"]
    new.tick(T0 + 300)                           # next boundary: measures normally
    new.handle_alert(alert(T0 + 300), T0 + 330)
    assert [(v["probe_id"], v["ok"]) for v in verdicts(logs)] == [(T0 + 300, True)]


# ------------------------------------------------------------- webhooks ----

def test_other_instances_webhook_is_ignored(logs):
    c = metrics_only("e2e-a")
    c.tick(T0)
    c.handle_alert(alert(T0, instance="e2e-b"), T0 + 30)
    assert verdicts(logs) == [] and ignored(logs) == ["other_instance"]
    assert c.snapshot()["pending_alert_checks"] == 1     # still waiting for its own


@pytest.mark.parametrize("a, reason", [
    (alert("1.76054e+09"), "unmatched"),                 # lossy rendering never matches
    (alert(""), "bad_probe_id"),
    (alert(T0, promise="logs_query"), "unknown_promise_or_tenant"),
    (alert(T0, tenant="team-z"), "unknown_promise_or_tenant"),
])
def test_bad_webhooks_never_produce_verdicts(logs, a, reason):
    c = metrics_only()
    c.tick(T0)
    c.handle_alert(a, T0 + 30)
    assert verdicts(logs) == [] and ignored(logs) == [reason]


def test_resolved_is_ignored_silently(logs):
    c = metrics_only()
    c.tick(T0)
    c.handle_alert(alert(T0, status="resolved"), T0 + 30)
    assert verdicts(logs) == [] and ignored(logs) == []


def test_webhook_after_deadline_before_sweep_is_timeout(logs):
    c = metrics_only()
    c.tick(T0)
    c.handle_alert(alert(T0), T0 + 200)          # deadline 180, sweep has not run yet
    c.tick(T0 + 201)
    assert [(v["ok"], v["reason"]) for v in verdicts(logs)] == [(False, "timeout")]


def test_telemetry_mirrors_verdicts(logs):
    tel = RecTelemetry()
    c = metrics_only(tel=tel)
    c.tick(T0)
    c.handle_alert(alert(T0), T0 + 10)
    c.handle_alert(alert(T0), T0 + 11)
    assert tel.calls == [("result", "metrics_alert", "team-a", True, None), ("ignored", "unmatched")]


# ------------------------------------------------------------- schedule ----

def test_first_tick_waits_for_next_boundary(logs):
    cfg = load()
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": FakePipeline(), "team-b": FakePipeline()})
    c._run_query = lambda *a: None
    c.tick(T0 + 10)
    assert [l["event"] for l in logs] == ["waiting_for_next_cycle"] and c.gauge.read() == (0, 0)
    c.tick(T0 + 300)
    c.pool.shutdown(wait=True)
    assert c.gauge.read() == (1, T0 + 300)
    assert c.snapshot()["pending_alert_checks"] == 4            # 2 alert promises x 2 tenants
    c.tick(T0 + 420)                                            # firing_seconds = 120
    assert c.gauge.read() == (0, T0 + 300)


def test_every_pending_check_times_out_exactly_once(logs):
    cfg = load()
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": FakePipeline(), "team-b": FakePipeline()})
    c._run_query = lambda *a: None
    c.tick(T0 - 1)
    for t in range(T0, T0 + 300):
        c.tick(t)
    c.pool.shutdown(wait=True)
    v = verdicts(logs)
    assert sorted((x["promise"], x["tenant"]) for x in v) == sorted(
        (p, t) for p in ("metrics_alert", "logs_alert") for t in ("team-a", "team-b"))
    assert all(x["reason"] == "timeout" for x in v)
    # deadlines are per promise: metrics 180 s, logs 240 s
    assert {x["promise"]: x["waited_seconds"] for x in v} == {"metrics_alert": 181, "logs_alert": 241}


def test_logs_alert_emit_error_is_a_failure_once(logs):
    cfg = load(promises=["logs_alert"], tenants=["team-a"])
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": FakePipeline(fail=True)})
    c.tick(T0 - 1)
    c.tick(T0)
    c.pool.shutdown(wait=True)
    c.tick(T0 + 299)          # past the 240 s deadline, same cycle: no second (timeout) verdict
    assert [(v["ok"], v["reason"]) for v in verdicts(logs)] == [(False, "emit_error")]


# --------------------------------------------------------- query checks ----

class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


class StepStop(threading.Event):
    """stop.wait(n) advances the fake clock instead of sleeping."""

    def __init__(self, clock):
        super().__init__()
        self.clock = clock

    def wait(self, timeout=None):
        self.clock.t += timeout or 0
        return self.is_set()


class ScriptedGrafana:
    def __init__(self, loki=(), tempo=()):
        self.loki, self.tempo = list(loki), list(tempo)
        self.seen = []

    def _next(self, seq):
        v = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(v, Exception):
            raise v
        return v

    def loki_count(self, uid, logql, start, end):
        self.seen.append((uid, logql))
        return self._next(self.loki)

    def tempo_span_count(self, uid, path):
        self.seen.append((uid, path))
        return self._next(self.tempo)


def run_query(promise, grafana, stop_after=None):
    cfg = load("e2e-b")
    clock = Clock(T0)
    stop = StepStop(clock)
    if stop_after:
        stop.set()
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": FakePipeline()},
                          grafana=grafana, clock=clock, stop=stop)
    c._run_query(cfg.promises[promise], cfg.tenants["team-a"], T0)


def test_logs_query_ok_after_partial(logs):
    g = ScriptedGrafana(loki=[0, 4, 10])
    run_query("logs_query", g)
    (r,) = verdicts(logs)
    assert r["ok"] is True and r["observed"] == 10 and r["latency_seconds"] == 15 and r["instance"] == "e2e-b"
    assert g.seen[0] == ("loki-team-a", '{service_name="heartbeat-probe"} | probe_check="logs_query" '
                                        f'| probe_id="{T0}" | probe_instance="e2e-b"')


def test_logs_query_incomplete_at_deadline(logs):
    run_query("logs_query", ScriptedGrafana(loki=[7]))
    (r,) = verdicts(logs)
    assert (r["ok"], r["reason"], r["observed"], r["expected"]) == (False, "incomplete", 7, 10)


def test_logs_query_error_reason(logs):
    run_query("logs_query", ScriptedGrafana(loki=[QueryError("HTTP 502")]))
    (r,) = verdicts(logs)
    assert r["reason"] == "query_error" and "502" in r["error"]


def test_query_check_on_shutdown_is_void(logs):
    run_query("logs_query", ScriptedGrafana(loki=[10]), stop_after=True)
    assert verdicts(logs) == []


def test_traces_query_not_found_then_ok(logs):
    g = ScriptedGrafana(tempo=[None, None, 5])
    run_query("traces_query", g)
    (r,) = verdicts(logs)
    assert r["ok"] is True and r["trace_id"] == "ab" * 16 and r["latency_seconds"] == 30
    assert g.seen[0] == ("tempo-team-a", "/api/traces/" + "ab" * 16)


def test_traces_query_not_found(logs):
    run_query("traces_query", ScriptedGrafana(tempo=[None]))
    assert verdicts(logs)[0]["reason"] == "not_found"


def test_count_spans_handles_v1_and_v2_shapes():
    v1 = {"batches": [{"scopeSpans": [{"spans": [{"spanId": "a", "name": "x"}, {"spanId": "b", "name": "y"}]}]}]}
    v2 = {"trace": {"resourceSpans": [{"scopeSpans": [{"spans": [{"spanId": "a", "name": "x",
                                                                  "links": [{"spanId": "z"}]}]}]}]}}
    assert _count_spans(v1) == 2 and _count_spans(v2) == 1


# ------------------------------------------------- export failures, sizing ----

REJECTED = {"ok": False, "since": 0, "status_code": 401, "reason": "Unauthorized"}


def test_query_check_fails_fast_when_write_is_rejected(logs):
    cfg = load("e2e-a")
    g = ScriptedGrafana(loki=[0])
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": FakePipeline(export={"logs": REJECTED})},
                          grafana=g, clock=Clock(T0), stop=StepStop(Clock(T0)))
    c._run_query(cfg.promises["logs_query"], cfg.tenants["team-a"], T0)
    (r,) = verdicts(logs)
    assert (r["ok"], r["reason"], r["export_status_code"], r["export_error"]) == (False, "export_failed", 401, "Unauthorized")
    assert g.seen == []                                     # no polling until the deadline


def test_logs_alert_rejected_write_is_export_failed_once(logs):
    cfg = load(promises=["logs_alert"], tenants=["team-a"])
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": FakePipeline(export={"logs": REJECTED})})
    c.tick(T0 - 1)
    c.tick(T0)
    c.pool.shutdown(wait=True)
    c.tick(T0 + 299)
    assert [(v["reason"], v["export_status_code"]) for v in verdicts(logs)] == [("export_failed", 401)]


def test_alert_timeout_names_export_failure(logs):
    cfg = load(promises=["metrics_alert"], tenants=["team-a"])
    pipe = FakePipeline(export={"metrics": {"ok": True, "since": 0}})
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": pipe})
    c.tick(T0 - 1)
    c.tick(T0)
    pipe.export["metrics"] = dict(REJECTED, status_code=429, reason="Too Many Requests")
    c.tick(T0 + 181)
    (r,) = verdicts(logs)
    assert (r["reason"], r["export_status_code"]) == ("export_failed", 429)


def test_pool_has_a_worker_per_check_and_snapshot_reports_tick_age(logs):
    c = checks_mod.Checks(load(), RecTelemetry())
    assert c.pool._max_workers == 8 + 2                      # 4 promises x 2 tenants
    assert c.snapshot()["last_tick_age_seconds"] is None
    c.tick(T0)
    assert 0 <= c.snapshot()["last_tick_age_seconds"] < 5
