import copy
import os

import pytest
import yaml

from probe import config

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {"GRAFANA_TOKEN": "g", "PROBE_INSTANCE": "e2e-a",
       "OTLP_HEADERS_TEAM_A": "Authorization=Basic%20YQ==", "OTLP_HEADERS_TEAM_B": "Authorization=Basic%20Yg=="}


@pytest.fixture
def raw():
    with open(os.path.join(ROOT, "config.example.yaml")) as f:
        return yaml.safe_load(f)


def test_example_loads(raw):
    c = config.from_dict(raw, ENV)
    assert c.instance == "e2e-a" and list(c.instances) == ["e2e-a", "e2e-b"]
    assert set(c.promises) == {"metrics_alert", "logs_alert", "logs_query", "traces_query"}
    assert c.tenants["team-b"].otlp_headers == {"Authorization": "Basic Yg=="}
    assert len(list(c.tenant_promises())) == 8
    assert c.promises["logs_query"].deadline_seconds == 60
    assert c.promises["traces_query"].slo_window_days == 28       # default
    assert c.alerting["degraded_failures"] == 3
    assert "alerting" not in c.gcp


@pytest.mark.parametrize("instance", ["", "e2e-z"])
def test_instance_identity_must_be_listed(raw, instance):
    with pytest.raises(config.ConfigError, match="PROBE_INSTANCE"):
        config.from_dict(raw, {**ENV, "PROBE_INSTANCE": instance})


def test_render_mode_needs_no_identity_or_secrets(raw):
    c = config.from_dict(raw, {}, runtime=False)
    assert c.instance == "" and c.tenants["team-a"].otlp_headers == {} and c.grafana_token == ""


def test_secrets_required_at_runtime(raw):
    env = {k: v for k, v in ENV.items() if k != "OTLP_HEADERS_TEAM_B"}
    with pytest.raises(config.ConfigError, match="OTLP_HEADERS_TEAM_B"):
        config.from_dict(raw, env)


def test_promise_limited_to_tenants_and_disabled(raw):
    raw["promises"]["traces_query"]["tenants"] = ["team-a"]
    raw["promises"]["logs_alert"]["enabled"] = False
    c = config.from_dict(raw, ENV)
    assert "logs_alert" not in c.promises
    assert [t.name for p, t in c.tenant_promises() if p.name == "traces_query"] == ["team-a"]


@pytest.mark.parametrize("mutate, msg", [
    (lambda r: r["promises"].update(bogus={}), "unknown promise"),
    (lambda r: r["promises"]["logs_query"].update(latency_objective_seconds=5), "unknown settings"),
    (lambda r: r["promises"]["metrics_alert"].update(firing_seconds=300), "firing_seconds"),
    (lambda r: r["promises"]["logs_query"].update(deadline_seconds=301), "deadline_seconds"),
    (lambda r: r["promises"]["logs_query"].update(slo_target=1), "slo_target"),
    (lambda r: r["promises"]["logs_query"].update(count=0), "count"),
    (lambda r: r["promises"]["traces_query"].update(tenants=["nope"]), "unknown tenants"),
    (lambda r: r["tenants"][1]["datasources"].pop("tempo"), "datasources.tempo"),
    (lambda r: r["grafana"].pop("url"), "grafana.url"),
    (lambda r: r["tenants"].append(copy.deepcopy(r["tenants"][0])), "duplicated"),
    (lambda r: r["instances"].append(copy.deepcopy(r["instances"][0])), "listed twice"),
    (lambda r: r["instances"][0].update(name="E2E_A"), "lowercase"),
    (lambda r: r["instances"][1].pop("webhook_url"), "webhook_url"),
    (lambda r: r.pop("instances"), "instances"),
    (lambda r: r["probe"].update(self_metrics_tenant="x"), "self_metrics_tenant"),
])
def test_invalid(raw, mutate, msg):
    mutate(raw)
    with pytest.raises(config.ConfigError, match=msg):
        config.from_dict(raw, ENV)


def test_alert_windows_derive_from_period(raw):
    raw["probe"]["period_seconds"] = 120
    for p in raw["promises"].values():
        p["deadline_seconds"] = min(p["deadline_seconds"], 100)
        if "firing_seconds" in p:
            p["firing_seconds"] = 60
    c = config.from_dict(raw, ENV)
    assert (c.alerting["broken_window_seconds"], c.alerting["silent_window_seconds"]) == (240, 360)


@pytest.mark.parametrize("alerting, msg", [
    ({"broken_window_seconds": 500}, "broken_window_seconds"),      # < 300 + 240
    ({"silent_window_seconds": 800}, "silent_window_seconds"),      # < 600 + 240
    ({"degraded_failures": 0}, "degraded_failures"),
    ({"bogus": 1}, "unknown settings"),
])
def test_alert_window_validation(raw, alerting, msg):
    raw["gcp"]["alerting"] = alerting
    with pytest.raises(config.ConfigError, match=msg):
        config.from_dict(raw, ENV)


@pytest.mark.parametrize("old", ["page_channel_id", "ticket_channel_id"])
def test_renamed_channel_keys_are_reported(raw, old):
    raw["gcp"][old] = "1"
    with pytest.raises(config.ConfigError, match="renamed"):
        config.from_dict(raw, ENV)


def test_header_parsing():
    assert config.parse_otlp_headers("a=b%20c, X-Scope-OrgID=t1") == {"a": "b c", "X-Scope-OrgID": "t1"}
    with pytest.raises(config.ConfigError):
        config.parse_otlp_headers("novalue")
