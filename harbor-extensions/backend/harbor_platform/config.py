"""Runtime configuration: config file -> environment variables -> code arguments; later sources override earlier ones.

Two directories, deliberately separate so the container image and the governed content can be released independently:

  app_dir   platform code assets shipped in the image: sdk/, portal/dist/
  root      governed content mounted from object storage: connectors/, extensions/, config/grants.yaml

Both default to the repository checkout, so local development needs no configuration.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEV_IDENTITY_KEY = "dev-only-identity-signing-key-change-me"


def _bool(v: str) -> bool:
    return v.lower() in ("1", "true", "yes")


def _list(v: str) -> list[str]:
    return [o.strip() for o in v.split(",") if o.strip()]


def normalize_base_path(value: str | None) -> str:
    """"" or "/extensions" (leading slash, no trailing slash)."""
    v = (value or "").strip().strip("/")
    if not v:
        return ""
    if any(ch in v for ch in "?#%\\") or "//" in v or any(seg in (".", "..") for seg in v.split("/")):
        raise ValueError(f"invalid base_path: {value!r}")
    return "/" + v


@dataclass
class Settings:
    root: Path = REPO_ROOT
    release_id: str = ""  # set on GKE to require the immutable content snapshot's marker
    app_dir: Path = REPO_ROOT
    data_dir: Path = REPO_ROOT / "data"
    # Path prefix the service is served under, e.g. "/extensions" behind Harbor's ingress; "" serves at the root
    base_path: str = ""
    pat_service_url: str = "http://127.0.0.1:9001/pat"
    mock_base: str = "http://127.0.0.1:9001"
    identity_key: str = DEV_IDENTITY_KEY
    session_cookie: str = "harbor_session"
    portal_origins: list[str] = field(default_factory=list)
    introspect_ttl: float = 60.0
    introspect_stale: float = 600.0  # how long a cached identity may still be used when the PAT service is unavailable
    rate_limit: int = 60
    rate_window: float = 10.0
    max_body_bytes: int = 1024 * 1024
    upstream_timeout: float = 15.0
    allowed_data_classes: list[str] = field(default_factory=lambda: ["internal"])
    dev_login: bool = True
    # Host login page used when there is no session and dev login is off, e.g. Harbor's "/login?next={next}";
    # {next} is replaced with the URL-encoded page to return to
    login_url: str = ""
    cookie_secure: bool = False
    # "file": JSON Lines under data_dir (local); "stdout": one JSON line per decision (containers: picked up by the log agent)
    audit_sink: str = "file"
    secrets: dict[str, str] = field(default_factory=dict)

    @property
    def extensions_dir(self) -> Path:
        return self.root / "extensions"

    @property
    def connectors_dir(self) -> Path:
        return self.root / "connectors"

    @property
    def grants_file(self) -> Path:
        return self.root / "config" / "grants.yaml"

    @property
    def nav_file(self) -> Path:
        return self.root / "config" / "nav.yaml"

    @property
    def sdk_dir(self) -> Path:
        return self.app_dir / "sdk"

    @property
    def portal_dist(self) -> Path:
        return self.app_dir / "portal" / "dist"


_ENV = {
    "HARBOR_ROOT": ("root", Path),
    "HARBOR_RELEASE_ID": ("release_id", str),
    "HARBOR_APP_DIR": ("app_dir", Path),
    "HARBOR_DATA_DIR": ("data_dir", Path),
    "HARBOR_BASE_PATH": ("base_path", str),
    "HARBOR_PAT_URL": ("pat_service_url", str),
    "HARBOR_MOCK_BASE": ("mock_base", str),
    "HARBOR_IDENTITY_KEY": ("identity_key", str),
    "HARBOR_SESSION_COOKIE": ("session_cookie", str),
    "HARBOR_PORTAL_ORIGINS": ("portal_origins", _list),
    "HARBOR_RATE_LIMIT": ("rate_limit", int),
    "HARBOR_INTROSPECT_TTL": ("introspect_ttl", float),
    "HARBOR_ALLOWED_DATA_CLASSES": ("allowed_data_classes", _list),
    "HARBOR_DEV_LOGIN": ("dev_login", _bool),
    "HARBOR_COOKIE_SECURE": ("cookie_secure", _bool),
    "HARBOR_LOGIN_URL": ("login_url", str),
    "HARBOR_AUDIT_SINK": ("audit_sink", str),
}


def load_settings(**overrides: Any) -> Settings:
    s = Settings()
    names = {f.name for f in fields(Settings)}
    for k in overrides:
        if k not in names:
            raise TypeError(f"unknown setting {k}")

    # Config file: HARBOR_CONFIG (e.g. a mounted ConfigMap), else config/platform.yaml in the repo checkout
    cfg = Path(os.environ.get("HARBOR_CONFIG") or REPO_ROOT / "config" / "platform.yaml")
    if cfg.exists():
        for k, v in (yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}).items():
            if k in names:
                setattr(s, k, v)

    for env, (name, conv) in _ENV.items():
        if env in os.environ:
            setattr(s, name, conv(os.environ[env]))

    for k, v in overrides.items():
        setattr(s, k, v)

    s.root = Path(s.root)
    s.app_dir = Path(s.app_dir)
    s.data_dir = Path(s.data_dir)
    s.base_path = normalize_base_path(s.base_path)
    if s.release_id and not re.fullmatch(r"[a-f0-9]{40}", s.release_id):
        raise ValueError("HARBOR_RELEASE_ID must be a 40-character Git commit SHA")
    if s.audit_sink not in ("file", "stdout"):
        raise ValueError(f"audit_sink must be 'file' or 'stdout', not {s.audit_sink!r}")
    # Outside dev, refuse to start with the well-known dev signing key: every downstream would accept forged identities
    if not s.dev_login and s.identity_key == DEV_IDENTITY_KEY:
        raise ValueError("HARBOR_IDENTITY_KEY must be set when dev_login is off (the dev signing key is public)")

    # Connector credentials: env var HARBOR_SECRET_<NAME> (injected from the secrets service / a k8s Secret).
    # The dev credentials file is read only when dev login is on, so it can never leak into a production deployment.
    secrets: dict[str, str] = {}
    dev = s.root / "config" / "secrets.dev.yaml"
    if s.dev_login and dev.exists():
        secrets.update({str(k): str(v) for k, v in (yaml.safe_load(dev.read_text(encoding="utf-8")) or {}).items()})
    for k, v in os.environ.items():
        if k.startswith("HARBOR_SECRET_"):
            secrets[k.removeprefix("HARBOR_SECRET_")] = v
    secrets.update(s.secrets or {})
    s.secrets = secrets
    return s
