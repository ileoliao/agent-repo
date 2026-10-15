import copy
import os

import pytest
import yaml

from probe import config

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {"WEBHOOK_TOKEN": "t", "GRAFANA_TOKEN": "g", "REPLICA_ID": "heartbeat-probe-0",
       "OTLP_HEADERS_TEAM_A": "Authorization=Basic%20YQ==", "OTLP_HEADERS_TEAM_B": "Authorization=Basic%20Yg=="}


@pytest.fixture
def raw():
    with open(os.path.join(ROOT, "config.example.yaml")) as f:
        return yaml.safe_load(f)


def test_example_loads(raw):
    c = config.from_dict(raw, ENV)
    assert c.replica == "heartbeat-probe-0"
    assert set(c.promises) == {"metrics_alert", "logs_alert", "logs_query", "traces_query"}
    assert c.tenants["team-b"].otlp_headers == {"Authorization": "Basic Yg=="}
    assert len(list(c.tenant_promises())) == 8
    assert c.promises["logs_query"].count == 10
    assert c.promises["metrics_alert"].slo_target == 0.999      # explicit
    assert c.promises["logs_query"].absent_for_seconds == 900   # default


def test_promise_limited_to_tenants_and_disabled(raw):
    raw["promises"]["traces_query"]["tenants"] = ["team-a"]
    raw["promises"]["logs_alert"]["enabled"] = False
    c = config.from_dict(raw, ENV)
    assert "logs_alert" not in c.promises
    assert [t.name for p, t in c.tenant_promises() if p.name == "traces_query"] == ["team-a"]


@pytest.mark.parametrize("mutate, msg", [
    (lambda r: r["promises"].update(bogus={}), "unknown promise"),
    (lambda r: r["promises"]["metrics_alert"].update(firing_seconds=300), "firing_seconds"),
    (lambda r: r["promises"]["logs_query"].update(deadline_seconds=301), "deadline_seconds"),
    (lambda r: r["promises"]["logs_query"].update(slo_target=1), "slo_target"),
    (lambda r: r["promises"]["logs_query"].update(count=0), "count"),
    (lambda r: r["promises"]["traces_query"].update(tenants=["nope"]), "unknown tenants"),
    (lambda r: r["tenants"][1]["datasources"].pop("tempo"), "datasources.tempo"),
    (lambda r: r["grafana"].pop("url"), "grafana.url"),
    (lambda r: r["tenants"].append(copy.deepcopy(r["tenants"][0])), "duplicated"),
    (lambda r: r["probe"].update(self_metrics_tenant="x"), "self_metrics_tenant"),
])
def test_invalid(raw, mutate, msg):
    mutate(raw)
    with pytest.raises(config.ConfigError, match=msg):
        config.from_dict(raw, ENV)


def test_secrets_required_at_runtime_but_not_for_render(raw):
    env = {k: v for k, v in ENV.items() if k != "OTLP_HEADERS_TEAM_B"}
    with pytest.raises(config.ConfigError, match="OTLP_HEADERS_TEAM_B"):
        config.from_dict(raw, env)
    assert config.from_dict(raw, {}, require_secrets=False).tenants["team-b"].otlp_headers == {}


def test_header_parsing():
    assert config.parse_otlp_headers("a=b%20c, X-Scope-OrgID=t1") == {"a": "b c", "X-Scope-OrgID": "t1"}
    with pytest.raises(config.ConfigError):
        config.parse_otlp_headers("novalue")
