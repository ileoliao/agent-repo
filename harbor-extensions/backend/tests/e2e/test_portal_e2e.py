"""End-to-end: real browser + real processes (mock systems, platform, built portal).

  cd backend && pytest tests/e2e -v
Screenshots are saved in backend/tests/e2e/artifacts/.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

playwright = pytest.importorskip("playwright.sync_api")

BACKEND = Path(__file__).resolve().parents[2]
REPO = BACKEND.parent
ARTIFACTS = Path(__file__).parent / "artifacts"

pytestmark = pytest.mark.skipif(
    not (REPO / "portal" / "dist" / "index.html").exists(), reason="portal not built: cd portal && npm run build"
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(url: str, timeout: float = 20) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(url, timeout=1).status_code < 500:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"{url} is not ready")


@pytest.fixture(scope="module", params=["", "/extensions"], ids=["root", "base-path"])
def servers(request, tmp_path_factory):
    """Run every scenario twice: at the root, and under a base path as behind Harbor's ingress."""
    prefix = request.param
    mock_port, app_port = _free_port(), _free_port()
    origin = f"http://127.0.0.1:{app_port}"
    base = f"{origin}{prefix}/"
    data = tmp_path_factory.mktemp("data")
    env = {
        **os.environ,
        "HARBOR_DATA_DIR": str(data),
        "HARBOR_PAT_URL": f"http://127.0.0.1:{mock_port}/pat",
        "HARBOR_MOCK_BASE": f"http://127.0.0.1:{mock_port}",
        "HARBOR_PORTAL_ORIGINS": origin,
        "HARBOR_BASE_PATH": prefix,
    }
    procs = [
        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "mocks.app:app", "--port", str(mock_port), "--log-level", "warning"],
            cwd=BACKEND, env=env,
        ),
        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "harbor_platform.main:app", "--port", str(app_port), "--log-level", "warning"],
            cwd=BACKEND, env=env,
        ),
    ]
    try:
        _wait(f"http://127.0.0.1:{mock_port}/docs")
        _wait(f"{base}api/health")
        yield base
    finally:
        for p in procs:
            p.terminate()
            p.wait(timeout=10)


@pytest.fixture(scope="module")
def browser():
    if ARTIFACTS.exists():
        shutil.rmtree(ARTIFACTS)
    ARTIFACTS.mkdir()
    with playwright.sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser, servers):
    ctx = browser.new_context(base_url=servers, viewport={"width": 1280, "height": 860}, locale="en-GB")
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.errors = errors
    yield pg
    ctx.close()


def login(page, user: str) -> None:
    page.goto("./")
    page.locator(f'button[data-user="{user}"]').click()
    page.get_by_role("heading", name="Extensions", exact=True).wait_for()


def shot(page, name: str) -> None:
    page.screenshot(path=str(ARTIFACTS / f"{name}.png"), full_page=False)


def test_login_and_catalog(page):
    page.goto("./")
    page.get_by_role("heading", name="Dev environment sign-in").wait_for()
    shot(page, "01-login")
    login(page, "alice")
    cards = page.locator("[data-extension]")
    assert {"outage-console", "release-calendar"} <= set(cards.evaluate_all("els => els.map(el => el.dataset.extension)"))
    shot(page, "02-catalog")
    assert page.errors == []


def open_outage(page, user: str, title: str | None = None):
    login(page, user)
    page.goto("x/outage-console")
    frame = page.frame_locator("iframe.ext-frame")
    frame.locator('[data-outage-id="OUT-1042"]').wait_for()
    if title:
        frame.locator("button.outage", has_text=title).click()
        frame.locator("[data-detail-title]", has_text=title).wait_for()
    return frame


def test_outage_console_team_service_roundtrip(page):
    """Team-built service + gateway: the declarer becomes the commander; updates record the real actor; "only the commander can recover" is enforced by the service and shown as-is."""
    title = "Core batch delay"
    frame = open_outage(page, "dave")
    frame.get_by_role("button", name="Declare outage").click()
    frame.get_by_label("Title").fill(title)
    frame.get_by_label("Severity").select_option("P1")
    frame.get_by_label("Affected systems").fill("core-batch, payment-gateway")
    frame.get_by_role("button", name="Declare", exact=True).click()
    frame.locator("[data-detail-title]", has_text=title).wait_for()
    assert "Dave Zhao (me)" in frame.locator(".facts").inner_text()

    page.get_by_role("button", name="Switch user").click()
    frame = open_outage(page, "alice", title)
    frame.get_by_label("Update").fill("Batch queue backlog of 12,000 items; scaling up workers")
    frame.get_by_role("button", name="Post update").click()
    frame.locator(".timeline").get_by_text("Batch queue backlog of 12,000 items; scaling up workers").wait_for()
    assert "Alice Wang" in frame.locator(".tl-item").first.inner_text()
    shot(page, "03-outage-alice")

    frame.get_by_label("Update").fill("Resolved")
    frame.get_by_label("Status").select_option("resolved")
    frame.get_by_role("button", name="Post update").click()
    frame.get_by_text("Only the commander Dave Zhao can declare recovery").wait_for()  # the team service's business rule
    shot(page, "04-outage-business-rule")

    page.get_by_role("button", name="Switch user").click()
    frame = open_outage(page, "dave", title)
    frame.get_by_label("Update").fill("Backlog cleared; declaring recovery")
    frame.get_by_label("Status").select_option("resolved")
    frame.get_by_role("button", name="Post update").click()
    frame.locator("#resolved button.outage", has_text=title).wait_for()
    assert page.errors == []


def test_outage_read_only_user(page):
    frame = open_outage(page, "carol")
    frame.get_by_text("Read-only: posting updates requires joining APP-INCIDENT-RESPONDER").wait_for()
    assert frame.get_by_role("button", name="Post update").count() == 0
    frame.get_by_text("Cannot view change requests").wait_for()  # carol does not have APP-SNOW-READ
    assert "null" not in frame.locator("#detail").inner_text()
    shot(page, "05-outage-carol-readonly")


def test_extension_is_sandboxed(page):
    login(page, "alice")
    page.goto("x/outage-console")
    page.frame_locator("iframe.ext-frame").locator('[data-outage-id="OUT-1042"]').wait_for()
    frame = next(f for f in page.frames if "/ext/outage-console/" in f.url)
    result = frame.evaluate(
        """async () => {
          const out = {};
          try { await fetch('/gw/outage/api/outages'); out.fetch = 'allowed'; } catch (e) { out.fetch = 'blocked'; }
          try { out.cookie = document.cookie; out.cookieRead = 'allowed'; } catch (e) { out.cookieRead = 'blocked'; }
          try { void window.parent.document.title; out.parentDom = 'allowed'; } catch (e) { out.parentDom = 'blocked'; }
          try { localStorage.setItem('x', '1'); out.storage = 'allowed'; } catch (e) { out.storage = 'blocked'; }
          out.origin = window.origin;
          return out;
        }"""
    )
    assert result["fetch"] == "blocked"  # CSP connect-src 'none'
    assert result["cookieRead"] == "blocked"  # opaque origin
    assert result["parentDom"] == "blocked"
    assert result["storage"] == "blocked"
    assert result["origin"] == "null"


def test_extension_cannot_spoof_another_extension(page):
    """An extension claiming to be another extension in its message has no effect: the portal decides identity per iframe."""
    login(page, "bob")
    page.goto("x/release-calendar")
    page.frame_locator("iframe.ext-frame").locator("[data-date]").first.wait_for()
    frame = next(f for f in page.frames if "/ext/release-calendar/" in f.url)
    result = frame.evaluate(
        """() => new Promise((resolve) => {
          window.addEventListener('message', (e) => { if (e.data && e.data.id === 'spoof') resolve(e.data); });
          parent.postMessage({ harbor: 1, id: 'spoof', op: 'gw', connector: 'outage', method: 'GET', path: '/api/outages',
                               extension: 'outage-console', headers: { 'X-Harbor-Extension': 'outage-console' } }, '*');
        })"""
    )
    assert result["result"]["gatewayError"] == "not_declared"  # still judged as release-calendar


def test_release_calendar_per_user_capabilities(page):
    login(page, "alice")
    page.locator('[data-extension="release-calendar"]').click()
    frame = page.frame_locator("iframe.ext-frame")
    chg = frame.locator('[data-id="CHG0031001"]')
    chg.wait_for()
    assert "Window conflict" in chg.inner_text()
    assert chg.get_by_role("button", name="Approve").count() == 0  # alice is not a change manager
    assert frame.locator('[data-id="R-2042"]').get_by_text("I'm an approver").count() == 1
    assert "null" not in frame.locator("#stats").inner_text()
    shot(page, "06-calendar-alice")

    page.get_by_role("button", name="Permissions").click()
    page.get_by_text("Join APP-SNOW-CHANGE-MGR to get access").wait_for()
    shot(page, "07-permissions-alice")

    page.get_by_role("button", name="Switch user").click()
    login(page, "bob")
    page.goto("x/release-calendar")
    frame = page.frame_locator("iframe.ext-frame")
    chg = frame.locator('[data-id="CHG0031001"]')
    chg.get_by_role("button", name="Approve").click()
    chg.get_by_text("Approved by bob").wait_for()
    assert "Scheduled" in chg.inner_text()
    shot(page, "08-calendar-bob-approved")
    assert page.errors == []


def test_new_joiner_sees_friendly_permission_messages(page):
    login(page, "carol")
    page.goto("x/release-calendar")
    frame = page.frame_locator("iframe.ext-frame")
    frame.get_by_text("APP-SNOW-READ").wait_for()
    text = frame.locator("#messages").inner_text()
    assert "APP-HARBOR-READ" in text and "APP-SNOW-READ" in text
    assert "null" not in frame.locator("#stats").inner_text()
    shot(page, "09-calendar-carol")


def test_ops_user_sees_only_ops_extensions(page):
    login(page, "dave")
    assert page.locator("[data-extension]").count() == 1
    assert page.locator('[data-extension="outage-console"]').count() == 1
    page.goto("x/release-calendar")
    page.get_by_text("visible only to members of AD group").wait_for()


def test_connectors_and_audit(page):
    login(page, "pam")
    page.get_by_role("link", name="Connectors").click()
    page.get_by_text("snow.change.write").first.wait_for()
    assert "not open" in page.locator("tr", has_text="snow.incident.read").inner_text()
    shot(page, "10-connectors")
    page.get_by_role("link", name="Audit").click()
    page.get_by_text("missing_group").first.wait_for()
    assert page.get_by_text("snow.change.write").count() > 0
    shot(page, "11-audit")


def test_session_expiry_is_handled_by_portal(page):
    """When the session expires the extension need not handle login: the portal intercepts 401, prompts to sign in again, and returns to the original extension."""
    login(page, "alice")
    page.goto("x/outage-console")
    frame = page.frame_locator("iframe.ext-frame")
    frame.locator("[data-detail-title]").wait_for()
    page.context.clear_cookies()  # simulate session expiry
    frame.get_by_label("Update").fill("x")
    frame.get_by_role("button", name="Post update").click()
    page.get_by_role("alertdialog", name="Session expired").wait_for()
    shot(page, "12-session-expired")
    page.get_by_role("button", name="Sign in again").click()
    page.locator('button[data-user="alice"]').click()
    page.frame_locator("iframe.ext-frame").locator("[data-detail-title]").wait_for()
    assert page.url.endswith("/x/outage-console")


def test_external_links_open_outside_sandbox(page, servers):
    """External links in an extension open in a new tab outside the sandbox (the target system handles its own SSO)."""
    login(page, "alice")
    page.goto("x/outage-console")
    page.frame_locator("iframe.ext-frame").locator('[data-outage-id="OUT-1042"]').wait_for()
    frame = next(f for f in page.frames if "/ext/outage-console/" in f.url)
    frame.evaluate(
        """(url) => {
          const a = document.createElement('a');
          a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.id = 'ext-link'; a.textContent = 'open';
          document.body.append(a);
        }""",
        f"{servers}api/health",
    )
    with page.context.expect_page() as popup_info:
        page.frame_locator("iframe.ext-frame").locator("#ext-link").click()
    popup = popup_info.value
    popup.wait_for_load_state()
    assert servers.startswith(popup.evaluate("window.origin") + "/")  # no longer an opaque origin
    assert page.url.endswith("/x/outage-console")  # the portal page was not navigated away


def test_extension_file_cannot_run_outside_portal(page, servers):
    """Opening an extension URL directly is also sandboxed (CSP sandbox); without the portal nothing can be called."""
    page.goto("./")
    page.locator('button[data-user="alice"]').click()
    page.get_by_role("heading", name="Extensions", exact=True).wait_for()
    page.goto(f"{servers}ext/outage-console/index.html")
    origin = page.evaluate("window.origin")
    assert origin == "null"


def test_embedded_in_harbor_shell(page, servers):
    """Harbor's shell (same origin) frames the portal in embed mode: no portal chrome, sidebar from /api/nav,
    workspace reaches the extension, navigation and session loss are reported to the shell."""
    login(page, "alice")
    prefix = servers.split("://", 1)[1].split("/", 1)[1].rstrip("/")
    prefix = "/" + prefix if prefix else ""
    shell = (Path(__file__).parent / "harbor_shell.html").read_text(encoding="utf-8")
    page.goto(f"{servers}api/portal-config")  # any same-origin page without a CSP, to host the stand-in shell
    page.set_content(shell.replace("__BASE__", prefix).replace("__START__", "outage-console"))

    portal = page.frame_locator("#frame")
    portal.frame_locator("iframe.ext-frame").locator('[data-outage-id="OUT-1042"]').wait_for()
    assert portal.locator(".topbar").count() == 0  # Harbor provides the chrome
    page.locator('aside a.active[data-ext="outage-console"]').first.wait_for()
    page.wait_for_function("window.hostEvents.some(e => e.type === 'navigate' && e.extension === 'outage-console')")

    ext = next(f for f in page.frames if "/ext/outage-console/" in f.url)
    assert ext.evaluate("harbor.context()") == {"workspace": "payments", "embedded": True}
    shot(page, "13-harbor-shell-embedded")

    # Inside the portal: catalog, then another extension; the shell follows
    page.locator('aside a[data-ext=""]').click()
    portal.locator('[data-extension="release-calendar"]').click()
    page.wait_for_function("window.hostEvents.some(e => e.type === 'navigate' && e.extension === 'release-calendar')")
    page.locator('aside a.active[data-ext="release-calendar"]').first.wait_for()
    portal.frame_locator("iframe.ext-frame").locator('[data-id="CHG0031001"]').wait_for()
    shot(page, "14-harbor-shell-release")

    # Session gone (e.g. signed out of Harbor): the portal asks the shell to re-authenticate
    page.context.clear_cookies()
    cal = next(f for f in page.frames if "/ext/release-calendar/" in f.url)
    cal.evaluate("harbor.me().catch(() => null)")
    page.wait_for_function("window.hostEvents.some(e => e.type === 'auth-required')")
    assert page.errors == []
