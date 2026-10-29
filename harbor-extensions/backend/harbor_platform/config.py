"""Runtime configuration: config/platform.yaml -> environment variables -> code arguments; later sources override earlier ones."""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Settings:
    root: Path = REPO_ROOT
    data_dir: Path = REPO_ROOT / "data"
    pat_service_url: str = "http://127.0.0.1:9001/pat"
    mock_base: str = "http://127.0.0.1:9001"
    identity_key: str = "dev-only-identity-signing-key-change-me"
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
    cookie_secure: bool = False
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
    def sdk_dir(self) -> Path:
        return self.root / "sdk"

    @property
    def portal_dist(self) -> Path:
        return self.root / "portal" / "dist"


_ENV = {
    "HARBOR_ROOT": ("root", Path),
    "HARBOR_DATA_DIR": ("data_dir", Path),
    "HARBOR_PAT_URL": ("pat_service_url", str),
    "HARBOR_MOCK_BASE": ("mock_base", str),
    "HARBOR_IDENTITY_KEY": ("identity_key", str),
    "HARBOR_PORTAL_ORIGINS": ("portal_origins", lambda v: [o.strip() for o in v.split(",") if o.strip()]),
    "HARBOR_RATE_LIMIT": ("rate_limit", int),
    "HARBOR_INTROSPECT_TTL": ("introspect_ttl", float),
    "HARBOR_DEV_LOGIN": ("dev_login", lambda v: v.lower() in ("1", "true", "yes")),
    "HARBOR_COOKIE_SECURE": ("cookie_secure", lambda v: v.lower() in ("1", "true", "yes")),
}


def load_settings(**overrides: Any) -> Settings:
    s = Settings()
    names = {f.name for f in fields(Settings)}

    cfg = REPO_ROOT / "config" / "platform.yaml"
    if cfg.exists():
        for k, v in (yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}).items():
            if k in names:
                setattr(s, k, v)

    for env, (name, conv) in _ENV.items():
        if env in os.environ:
            setattr(s, name, conv(os.environ[env]))

    for k, v in overrides.items():
        if k not in names:
            raise TypeError(f"unknown setting {k}")
        setattr(s, k, v)

    s.root = Path(s.root)
    s.data_dir = Path(s.data_dir)

    # Connector credentials: dev file + env var HARBOR_SECRET_<NAME> (injected by the secrets service in production)
    secrets: dict[str, str] = {}
    dev = s.root / "config" / "secrets.dev.yaml"
    if dev.exists():
        secrets.update({str(k): str(v) for k, v in (yaml.safe_load(dev.read_text(encoding="utf-8")) or {}).items()})
    for k, v in os.environ.items():
        if k.startswith("HARBOR_SECRET_"):
            secrets[k.removeprefix("HARBOR_SECRET_")] = v
    secrets.update(s.secrets or {})
    s.secrets = secrets
    return s
