"""Extension code lint (CI).

The runtime sandbox and CSP already stop these patterns from working; flagging them at PR time
tells contributors (and Copilot) right away what to change, instead of finding a broken page after release.

  Errors (block merge): custom login or password collection, own network requests, inline scripts, loading external resources,
                    use of browser storage, which is unavailable in the sandbox.
  Needs review: use of HTML injection APIs such as innerHTML (may render other users' data as HTML).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

CODE_SUFFIXES = {".js", ".mjs", ".html", ".htm"}

ERROR_RULES: list[tuple[re.Pattern[str], str, set[str]]] = [
    (re.compile(r"""type\s*=\s*["']?password""", re.I), "Do not collect passwords: extensions inherit the portal login identity and must not implement their own login", CODE_SUFFIXES),
    (re.compile(r"\bfetch\s*\("), "Do not use fetch: extensions have no network access; use harbor.connector(...)", CODE_SUFFIXES),
    (re.compile(r"\bXMLHttpRequest\b"), "Do not use XMLHttpRequest: use harbor.connector(...)", CODE_SUFFIXES),
    (re.compile(r"\b(WebSocket|EventSource)\s*\("), "Do not open connections directly: extensions have no network access", CODE_SUFFIXES),
    (re.compile(r"\bsendBeacon\s*\("), "Do not use sendBeacon: extensions have no network access", CODE_SUFFIXES),
    (re.compile(r"\b(localStorage|sessionStorage|indexedDB)\b"), "There is no browser storage in the sandbox: keep data in a team service or the source system and read/write it through connectors", CODE_SUFFIXES),
    (re.compile(r"\bdocument\.cookie\b"), "Extensions cannot read cookies and do not need to: identity is passed by the portal", CODE_SUFFIXES),
    (re.compile(r"<script\b(?![^>]*\bsrc\s*=)[^>]*>", re.I), "Do not write inline scripts: CSP only allows same-origin .js files", {".html", ".htm"}),
    (re.compile(r"<[a-z][^>]*\son[a-z]+\s*=", re.I), "Do not write inline event handlers (onclick=...): use addEventListener in .js", {".html", ".htm"}),
    (re.compile(r"""<(script|link|img|iframe)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?//""", re.I), "Do not load external resources: only files in this extension directory and ../../sdk/ may be referenced", {".html", ".htm"}),
    (re.compile(r"""<(script|link|img)\b[^>]*\b(src|href)\s*=\s*["']?/(?!/)""", re.I), "Use relative paths (e.g. ../../sdk/harbor.js, ./app.js): absolute paths break when the platform is served under a base path such as /extensions", {".html", ".htm"}),
    (re.compile(r"""\bimport\b[^;]*?["'](https?:)?//"""), "Do not import modules from an external address", {".js", ".mjs"}),
]

REVIEW_RULES: list[tuple[re.Pattern[str], str, set[str]]] = [
    (re.compile(r"\.(innerHTML|outerHTML)\s*\+?=|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\("), "Uses an HTML injection API such as innerHTML; confirm untrusted data is not rendered as HTML", CODE_SUFFIXES),
]


@dataclass
class LintResult:
    errors: list[str] = field(default_factory=list)
    review: list[str] = field(default_factory=list)


def _strip_js_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    return re.sub(r"(^|[^:\\])//[^\n]*", r"\1", text)


def lint_extension(directory: Path) -> LintResult:
    result = LintResult()
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in CODE_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if path.suffix.lower() in {".js", ".mjs"}:
            text = _strip_js_comments(text)
        else:
            text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
        rel = path.relative_to(directory.parent.parent) if directory.parent.parent in path.parents else path
        for rules, bucket in ((ERROR_RULES, result.errors), (REVIEW_RULES, result.review)):
            for pattern, message, suffixes in rules:
                if path.suffix.lower() not in suffixes:
                    continue
                for m in pattern.finditer(text):
                    line = text.count("\n", 0, m.start()) + 1
                    bucket.append(f"{rel}:{line}: {message}")
    return result
