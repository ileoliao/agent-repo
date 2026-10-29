"""Extension code lint: violations are caught, valid code is not flagged."""

from __future__ import annotations

import pytest

from harbor_platform.lint import lint_extension
from harbor_platform.validate import validate


def _ext(tmp_path, files: dict[str, str]):
    d = tmp_path / "extensions" / "demo"
    d.mkdir(parents=True)
    for name, text in files.items():
        (d / name).write_text(text, encoding="utf-8")
    return d


@pytest.mark.parametrize(
    "name, text, expect",
    [
        ("index.html", '<input type="password" name="pwd">', "Do not collect passwords"),
        ("app.js", "el.innerHTML = `<input type='password'>`;", "Do not collect passwords"),
        ("app.js", "const r = await fetch('/gw/snow/x');", "Do not use fetch"),
        ("app.js", "new XMLHttpRequest()", "XMLHttpRequest"),
        ("app.js", "const ws = new WebSocket('ws://x');", "Do not open connections directly"),
        ("app.js", "localStorage.setItem('k', 1)", "browser storage"),
        ("app.js", "const c = document.cookie;", "cookie"),
        ("index.html", "<script>alert(1)</script>", "inline scripts"),
        ("index.html", '<button onclick="go()">x</button>', "inline event"),
        ("index.html", '<script src="https://cdn.example.com/x.js"></script>', "external resources"),
        ("index.html", '<link rel="stylesheet" href="//cdn.example.com/x.css">', "external resources"),
        ("app.js", 'import x from "https://esm.example.com/x.js";', "external address"),
    ],
)
def test_violations_are_errors(tmp_path, name, text, expect):
    result = lint_extension(_ext(tmp_path, {name: text}))
    assert any(expect in e for e in result.errors), result
    assert any(e.startswith("extensions/demo/") for e in result.errors)


def test_inner_html_needs_review(tmp_path):
    result = lint_extension(_ext(tmp_path, {"app.js": "box.innerHTML = data.name;"}))
    assert result.errors == []
    assert any("innerHTML" in r for r in result.review)


def test_no_false_positives(tmp_path):
    ok = {
        "index.html": (
            '<link rel="stylesheet" href="/sdk/harbor.css"><script src="/sdk/harbor.js"></script>'
            '<script src="app.js"></script><!-- <script>old()</script> -->'
            '<a href="https://snow.bank.internal/x" target="_blank" rel="noopener">Open in ServiceNow</a>'
        ),
        "app.js": (
            "// Do not use fetch(), nor localStorage\n"
            "/* innerHTML = x */\n"
            'const url = "https://snow.bank.internal/x";\n'
            "const res = await harbor.connector('snow').get('/api/x');\n"
            "el.textContent = res.data.name;\n"
            "el.addEventListener('click', go);\n"
        ),
    }
    result = lint_extension(_ext(tmp_path, ok))
    assert result.errors == [] and result.review == []


def test_validate_blocks_lint_errors(root):
    app = root / "extensions" / "outage-console" / "app.js"
    app.write_text(app.read_text(encoding="utf-8") + "\nfetch('/gw/outage/api/outages');\n", encoding="utf-8")
    report = validate(root)
    assert any("Do not use fetch" in e for e in report["errors"])


def test_validate_routes_inner_html_to_review(root):
    app = root / "extensions" / "outage-console" / "app.js"
    app.write_text(app.read_text(encoding="utf-8") + "\ndocument.body.innerHTML = '';\n", encoding="utf-8")
    report = validate(root)
    assert report["errors"] == []
    assert any("innerHTML" in r for r in report["review"]["outage-console"])
