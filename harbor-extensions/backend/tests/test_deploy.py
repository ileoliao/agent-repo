"""Deployment shape: served under a base path behind Harbor's ingress, k8s probes, stdout audit, prod config hygiene."""

from __future__ import annotations

import json
import shutil

import pytest

from harbor_platform.config import load_settings, normalize_base_path

from conftest import ext, login

BASE = "/extensions"


@pytest.fixture
def prefixed(make_client):
    c = make_client(base_path=BASE)
    r = c.post(f"{BASE}/auth/dev-login", json={"user": "alice"})
    assert r.status_code == 200, r.text
    return c


def test_session_cookie_is_scoped_to_base_path(make_client):
    c = make_client(base_path=BASE)
    r = c.post(f"{BASE}/auth/dev-login", json={"user": "alice"})
    assert f"Path={BASE}/" in r.headers["set-cookie"]


def test_gateway_and_apis_under_base_path(prefixed):
    r = prefixed.get(f"{BASE}/gw/outage/api/outages", headers=ext("outage-console"))
    assert r.status_code == 200, r.text
    assert r.headers["X-Harbor-Capability"] == "outage.read"

    items = prefixed.get(f"{BASE}/api/extensions").json()["items"]
    assert items and all(i["entry"].startswith(f"{BASE}/ext/") for i in items)
    page = prefixed.get(items[0]["entry"])
    assert page.status_code == 200 and "sandbox" in page.headers["content-security-policy"]


def test_nothing_is_served_outside_base_path(prefixed):
    for path in ("/gw/outage/api/outages", "/api/me", "/sdk/harbor.js", "/"):
        assert prefixed.get(path, headers=ext("outage-console")).status_code == 404, path


def test_portal_gets_base_href(prefixed):
    assert prefixed.get(BASE, follow_redirects=False).headers["location"] == f"{BASE}/"
    for path in (f"{BASE}/", f"{BASE}/x/outage-console", f"{BASE}/index.html"):
        r = prefixed.get(path)
        if r.status_code == 503:
            pytest.skip("portal not built")
        assert f'<base href="{BASE}/" />' in r.text, path


def test_portal_at_root_keeps_root_base_href(client):
    r = client.get("/")
    if r.status_code == 503:
        pytest.skip("portal not built")
    assert '<base href="/" />' in r.text


def test_probes_are_at_root(make_client, root):
    c = make_client(base_path=BASE)
    assert c.get("/healthz").json() == {"ok": True}
    assert c.get("/readyz").status_code in (200, 503)  # 503 only if the portal is not built
    shutil.rmtree(root / "connectors")  # content mount is empty or unavailable
    r = c.get("/readyz")
    assert r.status_code == 503 and any("connectors" in m for m in r.json()["missing"])
    assert c.get("/healthz").status_code == 200


def test_readyz_rejects_invalid_content(make_client, root):
    c = make_client(base_path=BASE)
    connector = root / "connectors" / "broken.yaml"
    connector.write_text("name: broken\n", encoding="utf-8")
    response = c.get("/readyz")
    assert response.status_code == 503
    assert any("broken" in item for item in response.json()["config_errors"])
    connector.unlink()
    assert c.get("/readyz").status_code in (200, 503)  # portal may be unbuilt


def test_readyz_does_not_pin_a_content_release(make_client, root):
    c = make_client(base_path=BASE)
    before = c.get("/readyz").status_code
    (root / "config" / "release.json").write_text('{"id":"' + "b" * 40 + '"}\n', encoding="utf-8")
    assert c.get("/readyz").status_code == before


def test_release_id_setting_is_gone(root, monkeypatch):
    monkeypatch.setenv("HARBOR_RELEASE_ID", "not-a-sha")
    assert not hasattr(load_settings(root=root), "release_id")


def test_publish_marker_and_dotfiles_are_not_served(client, root):
    login(client, "alice")
    folder = root / "extensions" / "outage-console"
    (folder / ".harbor-publish.json").write_text('{"commit":"' + "a" * 40 + '"}\n', encoding="utf-8")
    (folder / ".secret").mkdir()
    (folder / ".secret" / "x.js").write_text("x", encoding="utf-8")
    for path in (".harbor-publish.json", ".secret/x.js", "%2Eharbor-publish.json"):
        assert client.get(f"/ext/outage-console/{path}").status_code == 404, path
    assert client.get("/ext/outage-console/index.html").status_code == 200


def test_content_update_in_place_is_served_without_restart(client, root):
    """Bucket-only publishing: the same process serves a changed manifest and page after the files change."""
    login(client, "alice")
    folder = root / "extensions" / "outage-console"
    manifest = folder / "extension.yaml"
    title = next(i["title"] for i in client.get("/api/extensions").json()["items"] if i["name"] == "outage-console")
    manifest.write_text(manifest.read_text(encoding="utf-8").replace(f"title: {title}", "title: Outage Console v2"), encoding="utf-8")
    (folder / "index.html").write_text((folder / "index.html").read_text(encoding="utf-8") + "\n<!-- v2-marker -->\n", encoding="utf-8")
    items = {i["name"]: i for i in client.get("/api/extensions").json()["items"]}
    assert items["outage-console"]["title"] == "Outage Console v2"
    assert "v2-marker" in client.get("/ext/outage-console/index.html").text

def test_readyz_rejects_unknown_connector_reference(make_client, root):
    c = make_client(base_path=BASE)
    manifest = root / "extensions" / "outage-console" / "extension.yaml"
    manifest.write_text(manifest.read_text(encoding="utf-8").replace("outage.read", "missing.read"), encoding="utf-8")
    response = c.get("/readyz")
    assert response.status_code == 503
    assert any("not registered" in item for item in response.json()["config_errors"])


def test_stdout_audit(make_client, capsys):
    c = make_client(audit_sink="stdout")
    c.post("/auth/dev-login", json={"user": "alice"})
    c.get("/gw/outage/api/outages", headers=ext("outage-console"))
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{"harbor_audit"')]
    assert any(e["harbor_audit"]["connector"] == "outage" and e["harbor_audit"]["decision"] == "allow" for e in lines)


def test_dev_secrets_ignored_without_dev_login(root, monkeypatch):
    monkeypatch.setenv("HARBOR_SECRET_SNOW_TOKEN", "from-secret-manager")
    s = load_settings(root=root, dev_login=False, identity_key="k" * 32)
    assert s.secrets.get("SNOW_TOKEN") == "from-secret-manager"
    assert "JIRA_TOKEN" not in s.secrets
    assert "JIRA_TOKEN" in load_settings(root=root, dev_login=True).secrets


def test_prod_refuses_dev_signing_key(root):
    with pytest.raises(ValueError, match="HARBOR_IDENTITY_KEY"):
        load_settings(root=root, dev_login=False)


@pytest.mark.parametrize("raw, expect", [("", ""), ("/", ""), ("extensions", "/extensions"), ("/a/b/", "/a/b")])
def test_base_path_normalization(raw, expect):
    assert normalize_base_path(raw) == expect


@pytest.mark.parametrize("raw", ["/a/../b", "/a//b", "/a%2fb", "/a?x"])
def test_base_path_rejects_odd_values(raw):
    with pytest.raises(ValueError):
        normalize_base_path(raw)
