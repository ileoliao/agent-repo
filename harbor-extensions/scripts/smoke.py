#!/usr/bin/env python3
"""Smoke test against an already running dev environment (scripts/dev.sh), using the default config/platform.yaml.

  scripts/dev.sh                      # terminal 1
  python3 scripts/smoke.py            # terminal 2   (HARBOR_URL overrides http://127.0.0.1:8000)
  python3 scripts/smoke.py --no-browser   # HTTP/CLI checks only (no Playwright needed)

Unlike backend/tests/e2e (ephemeral ports, env overrides), this exercises the documented dev path.
Exit code 0 = all checks passed. Screenshots go to $SMOKE_ARTIFACTS (default /tmp/harbor-smoke).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import httpx

BASE = os.environ.get("HARBOR_URL", "http://127.0.0.1:8000").rstrip("/")
ART = Path(os.environ.get("SMOKE_ARTIFACTS", "/tmp/harbor-smoke"))
results: list[tuple[bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((ok, name))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail and not ok else ""))


def session(user: str) -> httpx.Client:
    c = httpx.Client(base_url=BASE, headers={"Origin": BASE}, timeout=15)
    r = c.post("/auth/dev-login", json={"user": user})
    assert r.status_code == 200, r.text
    return c


def http_checks() -> None:
    anon = httpx.Client(base_url=BASE, timeout=15)
    check("health ok, no config errors", anon.get("/api/health").json() == {"ok": True, "config_errors": []})
    check("unauthenticated /api/me -> 401", anon.get("/api/me").status_code == 401)
    users = [u["user"] for u in anon.get("/api/dev/users").json()]
    check("5 simulated users", users == ["alice", "bob", "carol", "dave", "pam"], str(users))

    expected_ext = {
        "alice": {"outage-console", "release-calendar"},
        "bob": {"outage-console", "release-calendar"},
        "carol": {"outage-console", "release-calendar"},
        "dave": {"outage-console"},
        "pam": {"outage-console", "release-calendar"},
    }
    for user, want in expected_ext.items():
        s = session(user)
        got = {e["name"] for e in s.get("/api/extensions").json()["items"]}
        check(f"{user}: extension catalog {sorted(want)}", got == want, str(got))

    ext = {"X-Harbor-Extension": "outage-console"}
    rel = {"X-Harbor-Extension": "release-calendar"}
    a, b, c, d = session("alice"), session("bob"), session("carol"), session("dave")
    check("alice reads outages via gateway", a.get("/gw/outage/api/outages?status=active", headers=ext).status_code == 200)
    check("session without X-Harbor-Extension rejected", a.get("/gw/outage/api/outages").status_code in (400, 401, 403))
    r = c.get("/gw/snow/api/now/table/change_request", headers=rel)
    check("carol denied snow.change.read (403 + gateway header)", r.status_code == 403 and "x-harbor-gateway-error" in r.headers)
    r = a.patch("/gw/snow/api/now/table/change_request/a1f0c2d4e5", headers=rel, json={"state": "scheduled"})
    check("alice cannot approve change (not change manager)", r.status_code == 403 and "x-harbor-gateway-error" in r.headers, str(r.status_code))
    check("bob reads change requests", b.get("/gw/snow/api/now/table/change_request", headers=rel).status_code == 200)
    check("dave: no jira/snow (403)", d.get("/gw/snow/api/now/table/change_request", headers=ext).status_code == 403)
    check("path traversal rejected", b.get("/gw/snow/api/now/table/change_request/%2e%2e/incident", headers=rel).status_code in (400, 403, 404))
    check("foreign Origin rejected", httpx.post(f"{BASE}/auth/dev-login", json={"user": "alice"}, headers={"Origin": "http://evil.example"}).status_code in (400, 403))

    f = httpx.get(f"{BASE}/ext/outage-console/index.html")
    csp = f.headers.get("content-security-policy", "")
    check("extension CSP sandbox + connect-src none", "sandbox allow-scripts" in csp and "connect-src 'none'" in csp, csp)
    check("secrets file not reachable via /ext", httpx.get(f"{BASE}/ext/outage-console/..%2f..%2fconfig%2fsecrets.dev.yaml").status_code in (400, 403, 404))
    check("sdk harbor.js served", httpx.get(f"{BASE}/sdk/harbor.js").status_code == 200)

    names = {x["name"] for x in session("alice").get("/api/connectors").json()["items"]}
    check("connectors: jira, snow, harbor-release, outage", {"jira", "snow", "harbor-release", "outage"} <= names, str(names))

    pam = session("pam")
    audit = pam.get("/api/audit")
    check("pam can read audit, records non-empty", audit.status_code == 200 and len(audit.json()["items"]) > 0, str(audit.status_code))
    check("alice denied audit", session("alice").get("/api/audit").status_code == 403)

    out = a.post("/auth/logout", headers=ext)
    check("logout then old cookie rejected", out.status_code == 200 and a.get("/api/me").status_code == 401, str(out.status_code))


def browser_checks() -> None:
    from playwright.sync_api import sync_playwright

    ART.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(base_url=BASE, viewport={"width": 1280, "height": 860}, locale="en-GB")
        pg = ctx.new_page()
        errors: list[str] = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        pg.goto("/")
        pg.get_by_role("heading", name="Dev environment sign-in").wait_for()
        pg.screenshot(path=str(ART / "01-login.png"))
        pg.locator('button[data-user="alice"]').click()
        pg.get_by_role("heading", name="Extensions", exact=True).wait_for()
        check("browser: alice login, 2 extension cards", pg.locator("[data-extension]").count() == 2)
        pg.screenshot(path=str(ART / "02-catalog.png"))

        pg.goto("/x/outage-console")
        fr = pg.frame_locator("iframe.ext-frame")
        fr.locator('[data-outage-id="OUT-1042"]').wait_for()
        check("browser: outage-console lists OUT-1042 (default config, real mock upstream)", True)
        pg.screenshot(path=str(ART / "03-outage-console.png"))

        pg.goto("/x/release-calendar")
        pg.frame_locator("iframe.ext-frame").locator("body").wait_for()
        pg.wait_for_timeout(1500)
        pg.screenshot(path=str(ART / "04-release-calendar.png"))
        text = pg.frame_locator("iframe.ext-frame").locator("body").inner_text()
        check("browser: release-calendar renders content", len(text) > 50, text[:80])

        pg.goto("/connectors")
        pg.wait_for_timeout(800)
        pg.screenshot(path=str(ART / "05-connectors.png"))
        check("browser: no uncaught page errors", errors == [], "; ".join(errors))
        br.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    try:
        httpx.get(f"{BASE}/api/health", timeout=3)
    except httpx.HTTPError:
        print(f"Cannot reach {BASE}: start scripts/dev.sh first", file=sys.stderr)
        return 2
    http_checks()
    if not args.no_browser:
        browser_checks()
    failed = [n for ok, n in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
