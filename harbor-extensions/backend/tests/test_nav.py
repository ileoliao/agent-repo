"""Navigation for a host shell (Harbor's sidebar): per-user nav API, promotions, workspaces, CI rules."""

from __future__ import annotations

import re
import shutil

import pytest

from conftest import login
from harbor_platform.extensions import load_extensions
from harbor_platform.validate import validate


def _nav(client, workspace: str | None = None) -> dict:
    r = client.get("/api/nav", params={"workspace": workspace} if workspace else None)
    assert r.status_code == 200, r.text
    return r.json()


def _set_nav(root, ext: str, nav_yaml: str) -> None:
    """Replace the extension's nav block (it sits right before capabilities:)."""
    m = root / "extensions" / ext / "extension.yaml"
    text = m.read_text(encoding="utf-8")
    text = re.sub(r"nav:\n(?:  .*\n)*", "", text)
    m.write_text(text.replace("capabilities:", nav_yaml + "capabilities:", 1), encoding="utf-8")


def test_nav_lists_only_what_the_user_may_open(client):
    login(client, "alice")
    names = {i["name"] for i in _nav(client)["items"]}
    assert names == {"outage-console", "release-calendar"}
    login(client, "dave")  # ops, not in the developer group
    assert {i["name"] for i in _nav(client)["items"]} == {"outage-console"}


def test_nav_items_carry_sections_and_embed_links(make_client):
    c = make_client(base_path="/extensions")
    c.post("/extensions/auth/dev-login", json={"user": "alice"})
    r = c.get("/extensions/api/nav").json()
    assert {s["key"] for s in r["sections"]} >= {"release", "operations"}
    item = next(i for i in r["items"] if i["name"] == "outage-console")
    assert item["section"] is None and item["featured"] is True
    assert next(i for i in r["items"] if i["name"] == "release-calendar")["section"] == "release"
    assert item["embed_src"] == "/extensions/x/outage-console?embed=1"
    assert r["catalog_href"] == "/extensions/"


def test_featured_is_capped_in_order(client, root):
    (root / "config" / "nav.yaml").write_text("max_featured: 1\nsections: {}\n", encoding="utf-8")
    _set_nav(root, "release-calendar", "nav:\n  featured: true\n  order: 1\n")
    login(client, "alice")
    featured = [i["name"] for i in _nav(client)["items"] if i["featured"]]
    assert featured == ["release-calendar"]  # order 1 beats outage-console's 10; cap is 1


def test_workspace_scoping(client, root):
    _set_nav(root, "release-calendar", "nav:\n  workspaces: [payments]\n")
    login(client, "alice")
    assert "release-calendar" not in {i["name"] for i in _nav(client)["items"]}
    assert "release-calendar" not in {i["name"] for i in _nav(client, "lending")["items"]}
    assert "release-calendar" in {i["name"] for i in _nav(client, "payments")["items"]}
    assert client.get("/api/nav", params={"workspace": "../x"}).status_code == 400


def test_nav_requires_a_session(client):
    assert client.get("/api/nav").status_code == 401


def test_portal_config_is_public(make_client):
    c = make_client(login_url="/login?next={next}")
    assert c.get("/api/portal-config").json() == {"dev_login": True, "login_url": "/login?next={next}"}


def test_portal_may_be_framed_by_same_origin_only(client):
    r = client.get("/")
    if r.status_code == 503:
        pytest.skip("portal not built")
    assert "frame-ancestors 'self'" in r.headers["content-security-policy"]


# --------------------------------------------------------------------- extension.yaml + CI


@pytest.mark.parametrize(
    "nav_yaml, expect",
    [
        ("nav:\n  featured: true\n", "only for official-tier"),
        ("nav:\n  order: -1\n", "nav.order"),
        ("nav:\n  workspaces: ['a b']\n", "nav.workspaces"),
        ("nav:\n  pinned: true\n", "Unknown nav field"),
    ],
)
def test_bad_nav_is_rejected(root, nav_yaml, expect):
    m = root / "extensions" / "release-calendar" / "extension.yaml"
    m.write_text(m.read_text(encoding="utf-8").replace("tier: official", "tier: community"), encoding="utf-8")
    _set_nav(root, "release-calendar", nav_yaml)
    _, errors = load_extensions(root / "extensions")
    assert any(expect in e for e in errors), errors


def test_unknown_section_is_an_error(root):
    _set_nav(root, "release-calendar", "nav:\n  section: nowhere\n")
    assert any("nav.section nowhere" in e for e in validate(root)["errors"])


def test_promotion_needs_review(root, tmp_path):
    base = tmp_path / "base"
    shutil.copytree(root, base)
    _set_nav(root, "release-calendar", "nav:\n  section: release\n  featured: true\n")
    report = validate(root, base)
    assert any("navigation promotion" in r for r in report["review"]["release-calendar"])
    # unchanged promotions on main do not need review again
    assert "outage-console" not in report["review"]


def test_nav_config_change_is_a_platform_change(root, tmp_path):
    base = tmp_path / "base"
    shutil.copytree(root, base)
    (root / "config" / "nav.yaml").write_text("max_featured: 9\nsections: {}\n", encoding="utf-8")
    assert "config/nav.yaml" in validate(root, base)["platform_changes"]
