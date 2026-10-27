"""Gateway: passthrough, authorization formula, denial reasons, security boundaries."""

from __future__ import annotations

import time

import jwt
import pytest
from conftest import KEY, PORTAL, ext, login, pat

from harbor_platform.paths import BadPath, check_path

CHG = "/gw/snow/api/now/table/change_request"


# ---------------------------------------------------------------- Authentication


def test_unauthenticated(client):
    r = client.get("/gw/jira/rest/api/2/issue/PAY-101")
    assert r.status_code == 401
    assert r.headers["x-harbor-gateway-error"] == "unauthenticated"


def test_invalid_pat(client):
    r = client.get("/gw/jira/rest/api/2/issue/PAY-101", headers=pat("pat_nope"))
    assert r.status_code == 401
    assert r.json()["error"] == "invalid_token"


# ---------------------------------------------------------------- Passthrough


def test_pat_passthrough_preserves_query_and_injects_credentials(client, state):
    r = client.get("/gw/jira/rest/api/2/search?jql=project%20%3D%20PAY", headers=pat("pat_alice_cli"))
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 2
    assert r.headers["x-harbor-capability"] == "jira.issue.read"

    seen = state.last["jira"]
    assert seen["path"] == "/jira/rest/api/2/search"
    assert seen["query"] == "jql=project%20%3D%20PAY"  # query string reaches the upstream verbatim
    assert seen["authorization"] == "Bearer svc-jira-token"  # the gateway injects the service account
    assert seen["actor"] == "alice"  # the downstream sees the real user from the identity claim
    assert seen["via"] == "pat"
    assert seen["capability"] == "jira.issue.read"
    assert seen["extension"] is None
    assert seen["request_id"] == r.headers["x-request-id"]


def test_upstream_status_and_body_pass_through(client):
    r = client.get(f"{CHG}/does-not-exist", headers=pat("pat_bob_all"))
    assert r.status_code == 404
    assert "x-harbor-gateway-error" not in r.headers  # it is the upstream's 404, not the gateway's
    assert r.json()["detail"]["error"]["message"] == "No Record found"


def test_upstream_set_cookie_is_stripped(client):
    login(client, "alice")
    r = client.get("/gw/harbor-release/api/releases", headers=ext("release-calendar"))
    assert r.status_code == 200
    assert "set-cookie" not in r.headers


def test_browser_cookie_is_not_forwarded(client, state):
    login(client, "alice")
    client.get("/gw/harbor-release/api/releases", headers=ext("release-calendar"))
    assert state.last["harbor"]["cookie"] is None


def test_write_passthrough_body(client, state):
    r = client.post(
        "/gw/jira/rest/api/2/issue/PAY-101/comment",
        json={"body": "Verified"},
        headers=pat("pat_bob_all"),
    )
    assert r.status_code == 201
    assert r.json() == {"id": "1", "author": "bob", "body": "Verified"}


# ---------------------------------------------------------------- Authorization formula


def test_pat_scope_denied(client):
    r = client.post("/gw/jira/rest/api/2/issue/PAY-101/comment", json={"body": "x"}, headers=pat("pat_alice_cli"))
    assert r.status_code == 403
    body = r.json()
    assert body["error"] == "scope"
    assert body["need"] == ["jira.issue.comment"]


def test_path_not_in_allow_list(client):
    r = client.get("/gw/jira/rest/api/2/user", headers=pat("pat_bob_all"))
    assert r.status_code == 403
    assert r.json()["error"] == "no_capability"


def test_method_not_in_allow_list(client):
    r = client.delete(f"{CHG}/a1f0c2d4e5", headers=pat("pat_bob_all"))
    assert r.status_code == 403
    assert r.json()["error"] == "no_capability"


def test_session_requires_extension(client):
    login(client, "alice")
    r = client.get(CHG)
    assert r.status_code == 400
    assert r.json()["error"] == "extension_required"


def test_extension_read(client, state):
    login(client, "alice")
    r = client.get(
        CHG,
        params={"sysparm_query": f"start_date>={state.week_start.isoformat()} 00:00:00"},
        headers=ext("release-calendar"),
    )
    assert r.status_code == 200
    assert len(r.json()["result"]) == 4
    assert state.last["snow"]["extension"] == "release-calendar"
    assert state.last["snow"]["via"] == "session"


def test_missing_group_for_write(client):
    login(client, "alice")
    r = client.patch(f"{CHG}/a1f0c2d4e5", json={"state": "scheduled"}, headers=ext("release-calendar"))
    assert r.status_code == 403
    body = r.json()
    assert body["error"] == "missing_group"
    assert body["need"] == ["APP-SNOW-CHANGE-MGR"]
    assert "APP-SNOW-CHANGE-MGR" in body["reason"]


def test_change_manager_can_write_and_downstream_records_real_user(client):
    login(client, "bob")
    r = client.patch(f"{CHG}/a1f0c2d4e5", json={"state": "scheduled"}, headers=ext("release-calendar"))
    assert r.status_code == 200, r.text
    assert r.json()["result"]["approved_by"] == "bob"


def test_capability_not_declared_by_extension(client):
    login(client, "bob")
    r = client.patch(f"{CHG}/a1f0c2d4e5", json={"state": "scheduled"}, headers=ext("outage-console"))
    assert r.status_code == 403
    assert r.json()["error"] == "not_declared"


def test_write_capability_requires_grant(client, root):
    (root / "config" / "grants.yaml").write_text("{}\n", encoding="utf-8")
    login(client, "bob")
    r = client.patch(f"{CHG}/a1f0c2d4e5", json={"state": "scheduled"}, headers=ext("release-calendar"))
    assert r.status_code == 403
    assert r.json()["error"] == "not_granted"


def test_confidential_capability_closed(client, mocks):
    st = mocks.state.mock
    st.users["bob"]["groups"].append("APP-SNOW-INCIDENT")
    r = client.get("/gw/snow/api/now/table/incident", headers=pat("pat_bob_all"))
    assert r.status_code == 403
    assert r.json()["error"] == "data_class"


def test_visibility(client):
    login(client, "dave")
    r = client.get("/gw/harbor-release/api/releases", headers=ext("release-calendar"))
    assert r.status_code == 403
    assert r.json()["error"] == "visibility"
    names = [e["name"] for e in client.get("/api/extensions").json()["items"]]
    assert names == ["outage-console"]  # ops only sees extensions open to APP-OPS


# ---------------------------------------------------------------- Team-built service (outage)

OUT = "/gw/outage/api/outages"


def test_team_service_gets_identity_without_service_account(client, state):
    login(client, "carol")
    r = client.get(OUT, params={"status": "active"}, headers=ext("outage-console"))
    assert r.status_code == 200
    assert [o["id"] for o in r.json()["items"]] == ["OUT-1042"]
    seen = state.last["outage"]
    assert seen["authorization"] is None  # identity-only: no service account injected
    assert seen["actor"] == "carol" and seen["extension"] == "outage-console"


def test_team_service_records_real_operator(client):
    login(client, "alice")
    r = client.post(
        OUT,
        json={"title": "Mobile banking login failing", "severity": "P1", "systems": ["mobile-banking"], "summary": "Login API 5xx"},
        headers=ext("outage-console"),
    )
    assert r.status_code == 201, r.text
    o = r.json()
    assert o["commander"] == "alice" and o["commander_name"] == "Alice Wang"
    assert o["updates"][0]["by"] == "alice"


def test_read_only_user_cannot_post_updates(client):
    login(client, "carol")
    r = client.post(f"{OUT}/OUT-1042/updates", json={"message": "x"}, headers=ext("outage-console"))
    assert r.status_code == 403
    assert r.json()["need"] == ["APP-INCIDENT-RESPONDER"]


def test_team_service_business_rule_passes_through(client):
    """The gateway lets it through (alice has the responder group), but "only the commander can declare recovery" is rejected by the team service, and the error is returned as-is."""
    login(client, "alice")
    r = client.post(f"{OUT}/OUT-1042/updates", json={"message": "Resolved", "status": "resolved"}, headers=ext("outage-console"))
    assert r.status_code == 403
    assert "x-harbor-gateway-error" not in r.headers
    assert r.json()["detail"]["error"]["code"] == "not_commander"
    login(client, "dave")
    r = client.post(f"{OUT}/OUT-1042/updates", json={"message": "Resolved", "status": "resolved"}, headers=ext("outage-console"))
    assert r.status_code == 201
    assert r.json()["status"] == "resolved" and r.json()["resolved_at"]


def test_agent_can_query_team_service_with_pat(client):
    r = client.get(OUT, params={"status": "active"}, headers=pat("pat_bob_all"))
    assert r.status_code == 200 and r.json()["items"][0]["id"] == "OUT-1042"


def test_unknown_connector_and_extension(client):
    login(client, "alice")
    assert client.get("/gw/nope/x", headers=ext("release-calendar")).json()["error"] == "unknown_connector"
    assert client.get("/gw/snow/x", headers=ext("nope")).json()["error"] == "unknown_extension"


def test_can_endpoint(client):
    login(client, "alice")
    r = client.get("/api/can", params={"connector": "snow", "capability": "change.write"}, headers=ext("release-calendar"))
    assert r.json()["allowed"] is False
    assert r.json()["code"] == "missing_group"
    login(client, "bob")
    r = client.get("/api/can", params={"connector": "snow", "capability": "change.write"}, headers=ext("release-calendar"))
    assert r.json()["allowed"] is True


# ---------------------------------------------------------------- Security boundaries


@pytest.mark.parametrize("origin", ["null", "http://evil.example"])
def test_foreign_origin_rejected(client, origin):
    login(client, "bob")
    r = client.get(CHG, headers={**ext("release-calendar"), "Origin": origin})
    assert r.status_code == 403
    assert r.json()["error"] == "bad_origin"


def test_portal_origin_accepted(client):
    login(client, "bob")
    r = client.get(CHG, headers={**ext("release-calendar"), "Origin": PORTAL})
    assert r.status_code == 200


@pytest.mark.parametrize(
    "path",
    [
        "/gw/snow/api/now/table/change_request/%2e%2e/incident",
        "/gw/snow/api/now/table/change_request/a%2Fb",
        "/gw/snow/api/now/table//change_request",
    ],
)
def test_ambiguous_paths_rejected(client, path):
    r = client.get(path, headers=pat("pat_bob_all"))
    assert r.status_code == 400
    assert r.json()["error"] == "bad_path"


def test_check_path_unit():
    for bad in ["/a/../b", "/a/./b", "//x", "/a\\b", "/a/%2Fb", "/a/%2e%2e/b", "/a/%00", "/a\x01"]:
        with pytest.raises(BadPath):
            check_path(bad)
    assert check_path("/a/b%20c") == ("/a/b%20c", "/a/b c")
    assert check_path("") == ("/", "/")


def test_rate_limit(make_client):
    c = make_client(rate_limit=3)
    codes = [c.get("/gw/jira/rest/api/2/issue/PAY-101", headers=pat("pat_alice_cli")).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


def test_upstream_unavailable(client, root):
    (root / "connectors" / "down.yaml").write_text(
        "name: down\nowner: platform-team\nupstream: http://unreachable.internal\n"
        "auth: {type: identity-only}\n"
        "capabilities:\n  ping.read:\n    allow: [GET /ping]\n    groups: [APP-DEV-ALL]\n",
        encoding="utf-8",
    )
    r = client.get("/gw/down/ping", headers=pat("pat_bob_all"))
    assert r.status_code == 502
    assert r.json()["error"] == "upstream_unavailable"


# ---------------------------------------------------------------- Identity cache and AD group changes


def test_introspect_is_cached(client, state):
    for _ in range(3):
        client.get("/gw/jira/rest/api/2/issue/PAY-101", headers=pat("pat_alice_cli"))
    assert state.introspect_calls == 1


def test_ad_group_change_takes_effect_after_ttl(make_client, state):
    c = make_client(introspect_ttl=0)
    login(c, "alice")
    url = f"{CHG}/a1f0c2d4e5"
    assert c.patch(url, json={"state": "scheduled"}, headers=ext("release-calendar")).status_code == 403
    state.users["alice"]["groups"].append("APP-SNOW-CHANGE-MGR")  # simulate AD approval going through
    r = c.patch(url, json={"state": "scheduled"}, headers=ext("release-calendar"))
    assert r.status_code == 200
    assert r.json()["result"]["approved_by"] == "alice"


def test_cached_identity_survives_pat_service_outage(make_client, root):
    c = make_client(introspect_ttl=0.05)
    assert c.get("/api/me", headers=pat("pat_bob_all")).status_code == 200
    c.app.state.runtime["introspector"]._url = "http://unreachable.internal/introspect"
    time.sleep(0.1)
    assert c.get("/api/me", headers=pat("pat_bob_all")).status_code == 200  # fall back on the cache
    r = c.get("/api/me", headers=pat("pat_alice_cli"))  # a credential that was never cached
    assert r.status_code == 503
    assert r.json()["error"] == "auth_unavailable"


def test_logout_revokes_session(client, state):
    login(client, "alice")
    token = client.cookies.get("harbor_session")
    assert client.get("/api/me").status_code == 200  # already in the gateway cache
    assert client.post("/auth/logout").status_code == 200
    assert token not in state.sessions
    r = client.get("/api/me", headers={"Cookie": f"harbor_session={token}"})  # replay of an intercepted old cookie
    assert r.status_code == 401


def test_cli_only_capability_rejected_in_browser(client, root):
    snow = root / "connectors" / "snow.yaml"
    snow.write_text(
        snow.read_text(encoding="utf-8").replace("    write: true\n", "    write: true\n    cli_only: true\n", 1),
        encoding="utf-8",
    )
    login(client, "bob")
    r = client.patch(f"{CHG}/a1f0c2d4e5", json={"state": "scheduled"}, headers=ext("release-calendar"))
    assert r.status_code == 403 and r.json()["error"] == "cli_only"
    client.cookies.clear()
    r = client.patch(f"{CHG}/a1f0c2d4e5", json={"state": "scheduled"}, headers=pat("pat_bob_all"))
    assert r.status_code == 200


# ---------------------------------------------------------------- Audit


def test_audit_records_allow_and_deny(client):
    client.get("/gw/jira/rest/api/2/issue/PAY-101", headers=pat("pat_alice_cli"))
    client.post("/gw/jira/rest/api/2/issue/PAY-101/comment", json={}, headers=pat("pat_alice_cli"))
    assert client.get("/api/audit", headers=pat("pat_alice_cli")).status_code == 403
    login(client, "pam")
    items = client.get("/api/audit").json()["items"]
    decisions = [(i["capability"], i["decision"], i.get("code")) for i in items]
    assert ("jira.issue.comment", "deny", "scope") in decisions
    assert ("jira.issue.read", "allow", None) in decisions


def test_identity_token_claims():
    from harbor_platform.app import Context, identity_token
    from harbor_platform.auth import Principal
    from harbor_platform.config import load_settings

    s = load_settings(identity_key=KEY)
    p = Principal("alice", "Alice Wang", frozenset(), frozenset({"*"}), "session")
    token = identity_token(s, Context(p, None, "cookie", "rid1"), "snow", "snow.change.read")
    claims = jwt.decode(token, KEY, algorithms=["HS256"], audience="snow")
    assert claims["sub"] == "alice" and claims["cap"] == "snow.change.read"
    assert claims["exp"] - claims["iat"] == 60
