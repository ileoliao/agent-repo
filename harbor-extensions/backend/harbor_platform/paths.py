"""Gateway path validation.

The gateway forwards paths verbatim, but the path used for authorization matching must be the same as the one the upstream actually receives,
otherwise requests like /allowed/%2e%2e/secret could bypass the allow list. So anything the upstream
might reinterpret (encoded slashes and dots, backslashes, empty segments, . and .., control characters) is rejected.
"""

from __future__ import annotations

from urllib.parse import unquote


class BadPath(ValueError):
    pass


def check_path(raw: str) -> tuple[str, str]:
    """Return (path forwarded verbatim, decoded path used for matching)."""
    if not raw:
        raw = "/"
    if not raw.startswith("/"):
        raw = "/" + raw
    lowered = raw.lower()
    if any(t in lowered for t in ("%2f", "%5c", "%2e", "%00")):
        raise BadPath("Encoded slashes, backslashes, dots or NUL characters are not allowed in the path")
    if "\\" in raw or "//" in raw:
        raise BadPath("Backslashes and empty segments are not allowed in the path")
    decoded = unquote(raw)
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in decoded):
        raise BadPath("Control characters are not allowed in the path")
    if any(seg in (".", "..") for seg in decoded.split("/")):
        raise BadPath("'.' and '..' segments are not allowed in the path")
    return raw, decoded
