import os
import threading

import pytest
import yaml

from probe import checks as checks_mod
from probe import config
from probe.grafana import QueryError, _count_spans
from probe.report import Telemetry

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {"WEBHOOK_TOKEN": "t", "GRAFANA_TOKEN": "g", "REPLICA_ID": "heartbeat-probe-1",
       "OTLP_HEADERS_TEAM_A": "a=b", "OTLP_HEADERS_TEAM_B": "a=c"}
T0 = 1_760_538_000  # aligned to 300 s


def load(mutate=None):
    with open(os.path.join(ROOT, "config.example.yaml")) as f:
        raw = yaml.safe_load(f)
    if mutate:
        mutate(raw)
    return config.from_dict(raw, ENV)


@pytest.fixture
def logs(monkeypatch):
    out = []
    monkeypatch.setattr(checks_mod, "log", lambda sev, ev, **f: out.append({"severity": sev, "event": ev, **f}))
    return out


class RecTelemetry(Telemetry):
    def __init__(self):
        self.calls = []

    def started(self, promise, tenant):
        self.calls.append(("started", promise, tenant))

    def result(self, promise, tenant, origin, ok, reason, latency):
        self.calls.append(("result", promise, tenant, origin, ok, reason))


class FakePipeline:
    def __init__(self):
        self.logs, self.traces = [], []

    def emit_logs(self, check, probe_id, count):
        self.logs.append((check, probe_id, count))

    def emit_trace(self, probe_id, count):
        self.traces.append((probe_id, count))
        return "ab" * 16


def results(logs, **match):
    return [l for l in logs if l["event"] == "check_result" and all(l.get(k) == v for k, v in match.items())]


def alert(promise, pid, status="firing", tenant="team-a", replica="heartbeat-probe-0", label="replica"):
    return {"status": status, "labels": {"probe": "e2e", "promise": promise, "tenant": tenant, label: replica},
            "annotations": {"probe_id": str(pid)}}


# ------------------------------------------------------------ webhooks ----

def test_alert_from_another_replica_validates(logs):
    tel = RecTelemetry()
    c = checks_mod.Checks(load(), tel)
    c.handle_alert(alert("metrics_alert", T0), T0 + 42)
    c.handle_alert(alert("logs_alert", T0, label="probe_replica", tenant="team-b"), T0 + 70)
    r = results(logs)
    assert [(x["promise"], x["tenant"], x["replica"], x["ok"], x["latency_seconds"]) for x in r] == [
        ("metrics_alert", "team-a", "heartbeat-probe-0", True, 42),
        ("logs_alert", "team-b", "heartbeat-probe-0", True, 70)]
    assert all(x["received_by"] == "heartbeat-probe-1" for x in r)
    assert ("result", "metrics_alert", "team-a", "heartbeat-probe-0", True, None) in tel.calls


@pytest.mark.parametrize("pid, now, reason", [
    (T0, T0 + 301, "late"),
    (T0 + 300, T0 - 100, "from_future"),
    ("1.76054e+09", T0 + 5, "probe_id_not_aligned"),
    ("", T0 + 5, "missing_or_bad_probe_id"),
])
def test_bad_firing_is_explicit_failure(logs, pid, now, reason):
    checks_mod.Checks(load(), RecTelemetry()).handle_alert(alert("metrics_alert", pid), now)
    (r,) = results(logs)
    assert r["ok"] is False and r["reason"] == reason


def test_duplicate_resolved_and_unknown(logs):
    c = checks_mod.Checks(load(), RecTelemetry())
    c.handle_alert(alert("metrics_alert", T0), T0 + 30)
    c.handle_alert(alert("metrics_alert", T0), T0 + 60)                     # duplicate
    c.handle_alert(alert("metrics_alert", T0, "resolved"), T0 + 150)        # cleared at +120
    c.handle_alert(alert("logs_query", T0), T0 + 30)                        # not an alert promise
    c.handle_alert(alert("metrics_alert", T0, tenant="team-z"), T0 + 30)
    c.handle_alert({**alert("metrics_alert", T0), "labels": {"probe": "other"}}, T0 + 30)  # other probe
    assert len(results(logs)) == 1
    ignored = [l["reason"] for l in logs if l["event"] == "webhook_ignored"]
    assert ignored == ["duplicate", "unknown_promise", "unknown_tenant"]
    (res,) = [l for l in logs if l["event"] == "alert_resolved"]
    assert res["ok"] is True and res["latency_seconds"] == 30


# ------------------------------------------------------------ schedule ----

def test_cycle_starts_every_check_and_drives_gauge(logs):
    cfg = load()
    pipes = {"team-a": FakePipeline(), "team-b": FakePipeline()}
    tel = RecTelemetry()
    c = checks_mod.Checks(cfg, tel, pipelines=pipes, grafana=None)
    c._run_query = lambda p, t, pid: None          # query loop tested separately
    c.tick(T0)
    c.pool.shutdown(wait=True)
    started = [(l["promise"], l["tenant"]) for l in logs if l["event"] == "check_started"]
    assert len(started) == 8 and len(set(started)) == 8
    assert c.gauge.read() == (1, T0)
    assert pipes["team-a"].logs == [("logs_alert", T0, 1)]
    c.tick(T0 + 120)
    assert c.gauge.read() == (0, T0)
    assert [l["event"] for l in logs].count("probe_cleared") == 1


def test_restart_late_in_cycle_skips_what_cannot_finish(logs):
    cfg = load()
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": FakePipeline(), "team-b": FakePipeline()})
    c._run_query = lambda p, t, pid: None
    c.tick(T0 + 150)   # past firing (120 s) and past 300-180 for traces, before 300-120 for logs_query
    c.pool.shutdown(wait=True)
    started = {l["promise"] for l in logs if l["event"] == "check_started"}
    assert started == {"logs_query"}
    assert c.gauge.read() == (0, 0)


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
        self.seen_queries = []

    def _next(self, seq):
        v = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(v, Exception):
            raise v
        return v

    def loki_count(self, uid, logql, start, end):
        self.seen_queries.append((uid, logql))
        return self._next(self.loki)

    def tempo_span_count(self, uid, path):
        self.seen_queries.append((uid, path))
        return self._next(self.tempo)


def run_query(promise, grafana, logs_fixture):
    cfg = load()
    clock = Clock(T0)
    c = checks_mod.Checks(cfg, RecTelemetry(), pipelines={"team-a": FakePipeline()},
                          grafana=grafana, clock=clock, stop=StepStop(clock))
    c._run_query(cfg.promises[promise], cfg.tenants["team-a"], T0)
    return results(logs_fixture)


def test_logs_query_ok_after_partial(logs):
    g = ScriptedGrafana(loki=[0, 4, 10])
    (r,) = run_query("logs_query", g, logs)
    assert r["ok"] is True and r["observed"] == 10 and r["latency_seconds"] == 15
    uid, q = g.seen_queries[0]
    assert uid == "loki-team-a"
    assert q == ('{service_name="heartbeat-probe"} | probe_check="logs_query" '
                 f'| probe_id="{T0}" | probe_replica="heartbeat-probe-1"')


def test_logs_query_incomplete_at_deadline(logs):
    (r,) = run_query("logs_query", ScriptedGrafana(loki=[7]), logs)
    assert (r["ok"], r["reason"], r["observed"], r["expected"]) == (False, "incomplete", 7, 10)


def test_logs_query_error_reason(logs):
    (r,) = run_query("logs_query", ScriptedGrafana(loki=[QueryError("HTTP 502")]), logs)
    assert r["reason"] == "query_error" and "502" in r["error"]


def test_traces_query_not_found_then_ok(logs):
    g = ScriptedGrafana(tempo=[None, None, 5])
    (r,) = run_query("traces_query", g, logs)
    assert r["ok"] is True and r["trace_id"] == "ab" * 16 and r["latency_seconds"] == 30
    assert g.seen_queries[0] == ("tempo-team-a", "/api/traces/" + "ab" * 16)


def test_traces_query_not_found(logs):
    (r,) = run_query("traces_query", ScriptedGrafana(tempo=[None]), logs)
    assert r["reason"] == "not_found"


def test_count_spans_handles_v1_and_v2_shapes():
    v1 = {"batches": [{"scopeSpans": [{"spans": [{"spanId": "a", "name": "x"}, {"spanId": "b", "name": "y"}]}]}]}
    v2 = {"trace": {"resourceSpans": [{"scopeSpans": [{"spans": [{"spanId": "a", "name": "x",
                                                                  "links": [{"spanId": "z"}]}]}]}]}}
    assert _count_spans(v1) == 2 and _count_spans(v2) == 1
