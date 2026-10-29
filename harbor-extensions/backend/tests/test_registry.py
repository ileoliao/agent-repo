"""Extension registration (hot reload), extension static files, CI validation."""

from __future__ import annotations

import shutil

import pytest
from conftest import login

from harbor_platform.connectors import ConfigError, parse_connector
from harbor_platform.validate import validate


# ---------------------------------------------------------------- Extension catalog and hot reload


def test_extension_catalog(client):
    login(client, "alice")
    items = {e["name"]: e for e in client.get("/api/extensions").json()["items"]}
    assert set(items) == {"outage-console", "release-calendar"}
    caps = {c["id"]: c for c in items["release-calendar"]["capabilities"]}
    assert caps["snow.change.write"]["granted"] is True
    assert caps["snow.change.write"]["user_has_access"] is False  # alice is not a change manager
    assert caps["snow.change.read"]["user_has_access"] is True


def test_new_extension_appears_without_restart(client, root):
    login(client, "alice")
    assert len(client.get("/api/extensions").json()["items"]) == 2
    d = root / "extensions" / "hello"
    d.mkdir()
    (d / "index.html").write_text("<h1>hi</h1>", encoding="utf-8")
    (d / "extension.yaml").write_text(
        "name: hello\ntitle: Hello\nowner: team-x\nvisibility: [APP-DEV-ALL]\n", encoding="utf-8"
    )
    names = [e["name"] for e in client.get("/api/extensions").json()["items"]]
    assert "hello" in names


def test_invalid_extension_is_skipped_and_reported(client, root):
    d = root / "extensions" / "broken"
    d.mkdir()
    (d / "extension.yaml").write_text("name: broken\ntitle: x\n", encoding="utf-8")
    login(client, "alice")
    assert "broken" not in [e["name"] for e in client.get("/api/extensions").json()["items"]]
    assert any("broken" in e for e in client.get("/api/health").json()["config_errors"])


# ---------------------------------------------------------------- Extension static files


def test_extension_files_are_sandboxed(client):
    r = client.get("/ext/outage-console/index.html")
    assert r.status_code == 200
    csp = r.headers["content-security-policy"]
    assert "sandbox allow-scripts" in csp
    assert "allow-popups-to-escape-sandbox" in csp
    assert "allow-top-navigation" not in csp
    assert "connect-src 'none'" in csp
    assert "frame-ancestors 'self'" in csp
    assert "allow-same-origin" not in csp


@pytest.mark.parametrize(
    "url",
    ["/ext/outage-console/extension.yaml", "/ext/outage-console/..%2f..%2fconfig%2fsecrets.dev.yaml", "/ext/nope/index.html"],
)
def test_extension_files_cannot_escape(client, url):
    assert client.get(url).status_code == 404


def test_sdk_served(client):
    assert "harbor" in client.get("/sdk/harbor.js").text


# ---------------------------------------------------------------- CI validation


def test_validate_repo_is_clean(root):
    report = validate(root)
    assert report["errors"] == []
    assert report["review"] == {}


def test_validate_flags_new_write_capability(root):
    m = root / "extensions" / "outage-console" / "extension.yaml"
    m.write_text(m.read_text(encoding="utf-8") + "  - jira.issue.comment\n", encoding="utf-8")
    report = validate(root)
    assert report["errors"] == []
    assert any("jira.issue.comment" in r for r in report["review"]["outage-console"])


def test_validate_flags_visibility_expansion(root, tmp_path):
    base = tmp_path / "base"
    shutil.copytree(root, base)
    m = root / "extensions" / "release-calendar" / "extension.yaml"
    m.write_text(m.read_text(encoding="utf-8").replace("visibility: [APP-DEV-ALL]", "visibility: [APP-DEV-ALL, APP-OPS]"), encoding="utf-8")
    report = validate(root, base)
    assert any("APP-OPS" in r for r in report["review"]["release-calendar"])


def test_validate_flags_platform_file_changes(root, tmp_path):
    base = tmp_path / "base"
    shutil.copytree(root, base)
    (root / "config" / "grants.yaml").write_text("{}\n", encoding="utf-8")
    assert validate(root, base)["platform_changes"] == ["config/grants.yaml"]


def test_validate_catches_unknown_capability(root):
    m = root / "extensions" / "outage-console" / "extension.yaml"
    m.write_text(m.read_text(encoding="utf-8") + "  - snow.nope\n", encoding="utf-8")
    assert any("nope" in e for e in validate(root)["errors"])


def test_unknown_manifest_field_rejected(root):
    m = root / "extensions" / "outage-console" / "extension.yaml"
    m.write_text(m.read_text(encoding="utf-8") + "storage: true\n", encoding="utf-8")
    assert any("Unknown field storage" in e for e in validate(root)["errors"])


def test_template_is_a_valid_extension(root):
    from harbor_platform.config import REPO_ROOT

    shutil.copytree(REPO_ROOT / "templates" / "extension-template", root / "extensions" / "my-extension")
    report = validate(root)
    assert report["errors"] == []
    assert "my-extension" in report["extensions"]


def test_connector_write_method_must_be_flagged():
    with pytest.raises(ConfigError, match="write: true"):
        parse_connector(
            {
                "name": "xy",
                "owner": "o",
                "upstream": "http://u",
                "auth": {"type": "identity-only"},
                "capabilities": {"a": {"allow": ["POST /a"], "groups": ["G"]}},
            },
            "xy.yaml",
            "",
        )
