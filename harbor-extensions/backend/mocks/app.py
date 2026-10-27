"""Mock internal systems for prototype development and testing.

Mount paths:
  /pat     PAT service (with AD groups): introspect, issue browser sessions, user list
  /jira    a subset of the Jira REST API
  /snow    a subset of the ServiceNow Table API
  /harbor  a subset of the Harbor Release API
  /outage  team-built outage service (reference implementation: trusts only the gateway identity claim and enforces its own business rules)

Downstream behaviour mimics real-world systems:
  * must carry the connector's service-account credential (Authorization: Bearer svc-...), otherwise 401;
  * must carry the gateway-issued identity claim (X-Harbor-Identity), whose signature and aud are verified,
    and the sub inside is recorded as the "real actor" (e.g. the approver of a change request).
"""

from __future__ import annotations

import os
import re
import secrets
import time
from datetime import date, datetime, timedelta
from typing import Any

import jwt
from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException, Request, Response

DEFAULT_IDENTITY_KEY = "dev-only-identity-signing-key-change-me"


# --------------------------------------------------------------------------- Data


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


class MockState:
    def __init__(self, today: date | None = None) -> None:
        today = today or date.today()
        ws = _monday(today)

        def day(offset: int) -> str:
            return (ws + timedelta(days=offset)).isoformat()

        self.week_start = ws

        # ---------------------------------------------------------- Users and AD groups
        read_groups = ["APP-DEV-ALL", "APP-JIRA-READ", "APP-SNOW-READ", "APP-HARBOR-READ"]
        self.users: dict[str, dict[str, Any]] = {
            "alice": {
                "display_name": "Alice Wang",
                "title": "Payments developer, outage responder",
                "groups": read_groups + ["APP-INCIDENT-RESPONDER"],
            },
            "bob": {
                "display_name": "Bob Li",
                "title": "Change manager",
                "groups": read_groups + ["APP-SNOW-CHANGE-MGR", "APP-JIRA-WRITE"],
            },
            "carol": {
                "display_name": "Carol Chen",
                "title": "New engineer (has not yet requested system access)",
                "groups": ["APP-DEV-ALL"],
            },
            "dave": {
                "display_name": "Dave Zhao",
                "title": "Ops on-call (not in the developer group), incident commander",
                "groups": ["APP-OPS", "APP-INCIDENT-RESPONDER"],
            },
            "pam": {
                "display_name": "Pam Pan",
                "title": "Platform team admin",
                "groups": read_groups + ["APP-PLATFORM-ADMIN"],
            },
        }
        # PAT: a real PAT service stores only hashes; here plaintext is used as the key for readability
        self.pats: dict[str, dict[str, Any]] = {
            "pat_alice_cli": {"user": "alice", "scopes": ["jira.issue.read", "harbor-release.release.read"]},
            "pat_bob_all": {"user": "bob", "scopes": ["*"]},
        }
        self.sessions: dict[str, dict[str, Any]] = {}
        self.introspect_calls = 0
        self.last: dict[str, dict[str, Any]] = {}

        # ---------------------------------------------------------- Harbor Release
        self.releases: list[dict[str, Any]] = [
            {
                "id": "R-2041", "system": "payment-gateway", "version": "3.14.0",
                "title": "Payment Gateway 3.14: new split-payment API",
                "window_start": f"{day(1)} 20:00", "window_end": f"{day(1)} 22:00",
                "status": "scheduled", "approvers": ["bob"], "jira": "PAY-101",
            },
            {
                "id": "R-2042", "system": "loan-origination", "version": "2.7.1",
                "title": "Loan Origination 2.7.1: fix credit limit display",
                "window_start": f"{day(2)} 21:00", "window_end": f"{day(2)} 23:00",
                "status": "scheduled", "approvers": ["alice"], "jira": "LOAN-55",
            },
            {
                "id": "R-2043", "system": "customer-portal", "version": "5.2.0",
                "title": "Customer Portal 5.2: billing page redesign",
                "window_start": f"{day(3)} 20:30", "window_end": f"{day(3)} 22:30",
                "status": "pending-approval", "approvers": ["bob", "pam"], "jira": "PAY-102",
            },
            {
                "id": "R-2044", "system": "risk-engine", "version": "1.9.0",
                "title": "Risk Engine 1.9: hot rule reloading",
                "window_start": f"{day(8)} 20:00", "window_end": f"{day(8)} 23:00",
                "status": "draft", "approvers": ["bob"], "jira": None,
            },
            {
                "id": "R-2045", "system": "payment-gateway", "version": "3.14.1",
                "title": "Payment Gateway 3.14.1: patch",
                "window_start": f"{day(9)} 20:00", "window_end": f"{day(9)} 21:00",
                "status": "draft", "approvers": ["bob"], "jira": None,
            },
        ]

        # ---------------------------------------------------------- ServiceNow
        self.changes: list[dict[str, Any]] = [
            {
                "sys_id": "a1f0c2d4e5", "number": "CHG0031001",
                "short_description": "Payment Gateway database patch",
                "cmdb_ci": "payment-gateway",
                "start_date": f"{day(1)} 21:00:00", "end_date": f"{day(1)} 23:00:00",
                "state": "authorize", "assigned_to": "dba-team", "approved_by": "",
                "sys_updated_by": "system",
            },
            {
                "sys_id": "b2e1d3c5f6", "number": "CHG0031002",
                "short_description": "Core network firewall policy change",
                "cmdb_ci": "core-network",
                "start_date": f"{day(2)} 01:00:00", "end_date": f"{day(2)} 03:00:00",
                "state": "scheduled", "assigned_to": "network-team", "approved_by": "bob",
                "sys_updated_by": "bob",
            },
            {
                "sys_id": "c3d2e4b6a7", "number": "CHG0031003",
                "short_description": "Loan Origination parameter configuration change",
                "cmdb_ci": "loan-origination",
                "start_date": f"{day(4)} 19:00:00", "end_date": f"{day(4)} 20:00:00",
                "state": "authorize", "assigned_to": "loan-team", "approved_by": "",
                "sys_updated_by": "system",
            },
            {
                "sys_id": "d4c3f5a7b8", "number": "CHG0031004",
                "short_description": "Risk Engine JVM parameter tuning",
                "cmdb_ci": "risk-engine",
                "start_date": f"{day(8)} 21:00:00", "end_date": f"{day(8)} 22:00:00",
                "state": "assess", "assigned_to": "risk-team", "approved_by": "",
                "sys_updated_by": "system",
            },
        ]
        self.incidents: list[dict[str, Any]] = [
            {
                "sys_id": "f9e8d7c6b5", "number": "INC0042001",
                "short_description": "Customer reports transfer failure",
                "caller": "Customer Zhang", "customer_account": "6222 **** **** 1234",
            },
        ]


        # ---------------------------------------------------------- Outage (team-built service)
        now = datetime.now()

        def ts(minutes_ago: int) -> str:
            return (now - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%d %H:%M")

        self.outages: list[dict[str, Any]] = [
            {
                "id": "OUT-1042", "title": "Payment Gateway transaction success rate drop", "severity": "P2", "status": "identified",
                "systems": ["payment-gateway"], "commander": "dave", "commander_name": "Dave Zhao",
                "started_at": ts(47), "resolved_at": None,
                "updates": [
                    {"at": ts(47), "by": "dave", "by_name": "Dave Zhao", "status": "investigating", "message": "Monitoring alert: Payment Gateway success rate dropped from 99.9% to 97.2%; investigating"},
                    {"at": ts(31), "by": "alice", "by_name": "Alice Wang", "status": "investigating", "message": "Errors are concentrated on the split-payment API; downstream clearing is timing out"},
                    {"at": ts(12), "by": "dave", "by_name": "Dave Zhao", "status": "identified", "message": "Root cause identified: clearing connection pool exhausted; capacity increased, monitoring"},
                ],
            },
            {
                "id": "OUT-1039", "title": "Loan Origination page loading slowly", "severity": "P3", "status": "resolved",
                "systems": ["loan-origination", "customer-portal"], "commander": "alice", "commander_name": "Alice Wang",
                "started_at": ts(3 * 1440 + 200), "resolved_at": ts(3 * 1440 + 95),
                "updates": [
                    {"at": ts(3 * 1440 + 200), "by": "alice", "by_name": "Alice Wang", "status": "investigating", "message": "Users report the origination page takes over 10 seconds to open"},
                    {"at": ts(3 * 1440 + 95), "by": "alice", "by_name": "Alice Wang", "status": "resolved", "message": "Recovered after rolling back the CDN configuration"},
                ],
            },
        ]

        # ---------------------------------------------------------- Jira
        self.issues: dict[str, dict[str, Any]] = {
            "PAY-101": {"key": "PAY-101", "fields": {"summary": "Payment Gateway 3.14 go-live preparation", "status": "In Progress", "project": "PAY", "assignee": "alice"}},
            "PAY-102": {"key": "PAY-102", "fields": {"summary": "Billing page redesign integration testing", "status": "To Do", "project": "PAY", "assignee": "alice"}},
            "LOAN-55": {"key": "LOAN-55", "fields": {"summary": "Credit limit display error", "status": "Done", "project": "LOAN", "assignee": "carol"}},
        }
        self.comments: dict[str, list[dict[str, Any]]] = {}


OUTAGE_STATUSES = ("investigating", "identified", "monitoring", "resolved")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


# --------------------------------------------------------------------------- Query parsing


_COND = re.compile(r"^(\w+)(>=|<=|!=|>|<|=)(.*)$")
_OPS = {
    ">=": lambda a, b: a >= b,
    "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b,
    "<": lambda a, b: a < b,
    "=": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
}


def snow_filter(records: list[dict[str, Any]], query: str | None) -> list[dict[str, Any]]:
    """A minimal subset of ServiceNow sysparm_query: AND conditions joined by ^."""
    out = records
    for cond in (query or "").split("^"):
        m = _COND.match(cond.strip())
        if not m:
            continue
        field, op, value = m.groups()
        out = [r for r in out if _OPS[op](str(r.get(field, "")), value)]
    return out


def jql_filter(issues: list[dict[str, Any]], jql: str | None) -> list[dict[str, Any]]:
    """A minimal subset of JQL: field = value [AND field = value]."""
    out = issues
    for cond in re.split(r"\s+AND\s+", jql or "", flags=re.I):
        m = re.match(r"^\s*(\w+)\s*=\s*\"?([^\"]+?)\"?\s*$", cond)
        if not m:
            continue
        field, value = m.group(1).lower(), m.group(2)
        out = [i for i in out if str(i["fields"].get(field, "")).lower() == value.lower()]
    return out


# --------------------------------------------------------------------------- App


def create_mocks_app(identity_key: str | None = None, today: date | None = None) -> FastAPI:
    key = identity_key or os.environ.get("HARBOR_IDENTITY_KEY", DEFAULT_IDENTITY_KEY)
    st = MockState(today)
    app = FastAPI(title="Harbor prototype · mock internal systems")
    app.state.mock = st

    def downstream(system: str, audience: str, token: str | None):
        """Simulates a downstream system's entry checks: service account (a token of None means only the identity claim is trusted) + gateway identity claim. Returns the real actor."""

        def dependency(request: Request) -> str:
            if token is not None and request.headers.get("authorization") != f"Bearer {token}":
                raise HTTPException(401, {"error": "invalid service credential"})
            ident = request.headers.get("x-harbor-identity")
            if not ident:
                raise HTTPException(401, {"error": "missing X-Harbor-Identity"})
            try:
                claims = jwt.decode(ident, key, algorithms=["HS256"], audience=audience, issuer="harbor-gateway")
            except jwt.PyJWTError as exc:
                raise HTTPException(401, {"error": f"invalid identity: {exc}"}) from exc
            st.last[system] = {
                "method": request.method,
                "path": request.url.path,
                "query": request.url.query,
                "actor": claims["sub"],
                "extension": claims.get("ext"),
                "capability": claims.get("cap"),
                "via": claims.get("via"),
                "authorization": request.headers.get("authorization"),
                "request_id": request.headers.get("x-request-id"),
                "cookie": request.headers.get("cookie"),
            }
            request.state.claims = claims
            return claims["sub"]

        return dependency

    # ------------------------------------------------------------------ PAT
    pat = APIRouter(prefix="/pat", tags=["PAT service"])

    def _principal(user: str, scopes: list[str], kind: str, exp: float | None) -> dict[str, Any]:
        u = st.users[user]
        return {
            "active": True, "kind": kind, "user": user,
            "display_name": u["display_name"], "groups": list(u["groups"]),
            "scopes": scopes, "exp": exp,
        }

    @pat.post("/introspect")
    def introspect(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        st.introspect_calls += 1
        token = str(body.get("token", ""))
        if token in st.pats:
            p = st.pats[token]
            return _principal(p["user"], p["scopes"], "pat", None)
        s = st.sessions.get(token)
        if s and s["exp"] > time.time():
            return _principal(s["user"], ["*"], "session", s["exp"])
        return {"active": False}

    @pat.post("/session")
    def session(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        """In production issued after Kerberos authentication; the mock issues directly by username."""
        user = str(body.get("user", ""))
        if user not in st.users:
            raise HTTPException(404, {"error": "unknown user"})
        token = "sess_" + secrets.token_urlsafe(24)
        exp = time.time() + 8 * 3600
        st.sessions[token] = {"user": user, "exp": exp}
        return {"token": token, "expires_at": exp}

    @pat.get("/users")
    def users() -> list[dict[str, Any]]:
        return [{"user": k, **v} for k, v in st.users.items()]

    @pat.post("/revoke")
    def revoke(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        """Revoke a browser session (sign out)."""
        return {"revoked": st.sessions.pop(str(body.get("token", "")), None) is not None}

    app.include_router(pat)

    # ------------------------------------------------------------------ Harbor Release
    harbor = APIRouter(prefix="/harbor", tags=["Harbor Release"])
    harbor_actor = downstream("harbor", "harbor-release", "svc-harbor-token")

    @harbor.get("/api/releases")
    def list_releases(request: Request, response: Response, actor: str = Depends(harbor_actor)) -> dict[str, Any]:
        q = request.query_params
        items = st.releases
        if q.get("from"):
            items = [r for r in items if r["window_start"][:10] >= q["from"]]
        if q.get("to"):
            items = [r for r in items if r["window_start"][:10] <= q["to"]]
        if q.get("system"):
            items = [r for r in items if r["system"] == q["system"]]
        # used to verify that the gateway strips the upstream Set-Cookie
        response.set_cookie("upstream_session", "should-not-leak")
        return {"items": items, "total": len(items)}

    @harbor.get("/api/releases/{rid}")
    def get_release(rid: str, actor: str = Depends(harbor_actor)) -> dict[str, Any]:
        for r in st.releases:
            if r["id"] == rid:
                return r
        raise HTTPException(404, {"error": "release not found"})

    app.include_router(harbor)

    # ------------------------------------------------------------------ ServiceNow
    snow = APIRouter(prefix="/snow", tags=["ServiceNow"])
    snow_actor = downstream("snow", "snow", "svc-snow-token")

    def _find_change(sys_id: str) -> dict[str, Any]:
        for c in st.changes:
            if c["sys_id"] == sys_id:
                return c
        raise HTTPException(404, {"error": {"message": "No Record found", "detail": sys_id}})

    @snow.get("/api/now/table/change_request")
    def list_changes(request: Request, actor: str = Depends(snow_actor)) -> dict[str, Any]:
        q = request.query_params
        rows = snow_filter(st.changes, q.get("sysparm_query"))
        limit = int(q.get("sysparm_limit") or 100)
        return {"result": rows[:limit]}

    @snow.get("/api/now/table/change_request/{sys_id}")
    def get_change(sys_id: str, actor: str = Depends(snow_actor)) -> dict[str, Any]:
        return {"result": _find_change(sys_id)}

    @snow.patch("/api/now/table/change_request/{sys_id}")
    def patch_change(sys_id: str, body: dict[str, Any] = Body(...), actor: str = Depends(snow_actor)) -> dict[str, Any]:
        c = _find_change(sys_id)
        allowed = {"state", "short_description", "start_date", "end_date", "assigned_to"}
        for k, v in body.items():
            if k in allowed:
                c[k] = v
        if body.get("state") == "scheduled":
            c["approved_by"] = actor  # the downstream records the real approver from the identity passed through by the gateway
        c["sys_updated_by"] = actor
        return {"result": c}

    @snow.post("/api/now/table/change_request", status_code=201)
    def create_change(body: dict[str, Any] = Body(...), actor: str = Depends(snow_actor)) -> dict[str, Any]:
        n = len(st.changes) + 1
        c = {
            "sys_id": secrets.token_hex(5), "number": f"CHG00{31000 + n}",
            "short_description": body.get("short_description", ""),
            "cmdb_ci": body.get("cmdb_ci", ""),
            "start_date": body.get("start_date", ""), "end_date": body.get("end_date", ""),
            "state": "assess", "assigned_to": body.get("assigned_to", ""),
            "approved_by": "", "sys_updated_by": actor,
        }
        st.changes.append(c)
        return {"result": c}

    @snow.get("/api/now/table/incident")
    def list_incidents(actor: str = Depends(snow_actor)) -> dict[str, Any]:
        return {"result": st.incidents}

    app.include_router(snow)

    # ------------------------------------------------------------------ Outage (team-built service)
    # This is the reference implementation of "a team writes its own backend and onboards it through a connector":
    #   * no login and no SSO; it only verifies the gateway-issued identity claim and uses the user inside as the actor;
    #   * no service account needed (connector auth: identity-only);
    #   * fine-grained business rules live in the service itself, e.g. "only the commander can declare recovery".
    outage = APIRouter(prefix="/outage", tags=["Outage service (team-built)"])
    outage_actor = downstream("outage", "outage", None)

    def _find_outage(oid: str) -> dict[str, Any]:
        for o in st.outages:
            if o["id"] == oid:
                return o
        raise HTTPException(404, {"error": {"code": "not_found", "message": f"outage {oid} does not exist"}})

    def _bad(code: str, message: str, status: int = 422) -> HTTPException:
        return HTTPException(status, {"error": {"code": code, "message": message}})

    @outage.get("/api/outages")
    def list_outages(request: Request, actor: str = Depends(outage_actor)) -> dict[str, Any]:
        status = request.query_params.get("status")
        items = st.outages
        if status == "active":
            items = [o for o in items if o["status"] != "resolved"]
        elif status == "resolved":
            items = [o for o in items if o["status"] == "resolved"]
        items = sorted(items, key=lambda o: o["started_at"], reverse=True)
        return {"items": [{k: v for k, v in o.items() if k != "updates"} | {"last_update": o["updates"][-1]} for o in items]}

    @outage.get("/api/outages/{oid}")
    def get_outage(oid: str, actor: str = Depends(outage_actor)) -> dict[str, Any]:
        return _find_outage(oid)

    @outage.post("/api/outages", status_code=201)
    def declare_outage(request: Request, body: dict[str, Any] = Body(...), actor: str = Depends(outage_actor)) -> dict[str, Any]:
        title = str(body.get("title", "")).strip()
        severity = body.get("severity")
        systems = body.get("systems") or []
        summary = str(body.get("summary", "")).strip()
        if not title or len(title) > 80:
            raise _bad("invalid_title", "Title is required, at most 80 characters")
        if severity not in ("P1", "P2", "P3"):
            raise _bad("invalid_severity", "Severity must be P1, P2 or P3")
        if not isinstance(systems, list) or not systems or not all(isinstance(x, str) and x for x in systems):
            raise _bad("invalid_systems", "Enter at least one affected system")
        name = request.state.claims.get("name", actor)
        now = _now()
        o = {
            "id": f"OUT-{1040 + len(st.outages) + 1}",
            "title": title, "severity": severity, "status": "investigating",
            "systems": systems, "commander": actor, "commander_name": name,
            "started_at": now, "resolved_at": None,
            "updates": [{"at": now, "by": actor, "by_name": name, "status": "investigating", "message": summary or "Outage declared; investigating"}],
        }
        st.outages.append(o)
        return o

    @outage.post("/api/outages/{oid}/updates", status_code=201)
    def post_update(oid: str, request: Request, body: dict[str, Any] = Body(...), actor: str = Depends(outage_actor)) -> dict[str, Any]:
        o = _find_outage(oid)
        if o["status"] == "resolved":
            raise _bad("already_resolved", f"{oid} is already resolved and cannot be updated", 409)
        message = str(body.get("message", "")).strip()
        status = body.get("status") or o["status"]
        if not message or len(message) > 500:
            raise _bad("invalid_message", "Update message is required, at most 500 characters")
        if status not in OUTAGE_STATUSES:
            raise _bad("invalid_status", f"Status must be one of {', '.join(OUTAGE_STATUSES)}")
        if status == "resolved" and actor != o["commander"]:
            # Business rules are enforced inside the team service: the gateway only knows "may this endpoint be called", not who the commander is
            raise _bad("not_commander", f"Only the commander {o['commander_name']} can declare recovery", 403)
        name = request.state.claims.get("name", actor)
        now = _now()
        o["updates"].append({"at": now, "by": actor, "by_name": name, "status": status, "message": message})
        o["status"] = status
        if status == "resolved":
            o["resolved_at"] = now
        return o

    app.include_router(outage)

    # ------------------------------------------------------------------ Jira
    jira = APIRouter(prefix="/jira", tags=["Jira"])
    jira_actor = downstream("jira", "jira", "svc-jira-token")

    @jira.get("/rest/api/2/search")
    def search(request: Request, actor: str = Depends(jira_actor)) -> dict[str, Any]:
        issues = jql_filter(list(st.issues.values()), request.query_params.get("jql"))
        return {"issues": issues, "total": len(issues)}

    @jira.get("/rest/api/2/issue/{key}")
    def get_issue(key: str, actor: str = Depends(jira_actor)) -> dict[str, Any]:
        if key not in st.issues:
            raise HTTPException(404, {"errorMessages": ["Issue Does Not Exist"]})
        return {**st.issues[key], "comments": st.comments.get(key, [])}

    @jira.post("/rest/api/2/issue/{key}/comment", status_code=201)
    def add_comment(key: str, body: dict[str, Any] = Body(...), actor: str = Depends(jira_actor)) -> dict[str, Any]:
        if key not in st.issues:
            raise HTTPException(404, {"errorMessages": ["Issue Does Not Exist"]})
        c = {"id": str(len(st.comments.get(key, [])) + 1), "author": actor, "body": str(body.get("body", ""))}
        st.comments.setdefault(key, []).append(c)
        return c

    app.include_router(jira)
    return app


app = create_mocks_app()
