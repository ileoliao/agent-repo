from __future__ import annotations

import shutil
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from harbor_platform.app import create_app  # noqa: E402
from harbor_platform.config import REPO_ROOT, load_settings  # noqa: E402
from mocks.app import create_mocks_app  # noqa: E402

KEY = "test-identity-signing-key-0123456789abcdef"
PORTAL = "http://portal.test"


class RoutingTransport(httpx.AsyncBaseTransport):
    """Requests whose host is mocks go to the mock systems; every other address is unreachable (used to simulate upstream failures)."""

    def __init__(self, app) -> None:
        self._asgi = httpx.ASGITransport(app=app)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "mocks":
            return await self._asgi.handle_async_request(request)
        raise httpx.ConnectError("unreachable", request=request)


@pytest.fixture
def root(tmp_path: Path) -> Path:
    """A temporary copy of the repo contents; tests may freely modify extensions, connectors and grants."""
    dst = tmp_path / "repo"
    for name in ("config", "connectors", "sdk"):
        shutil.copytree(REPO_ROOT / name, dst / name)
    (dst / "extensions").mkdir()
    for name in ("outage-console", "release-calendar"):
        shutil.copytree(REPO_ROOT / "extensions" / name, dst / "extensions" / name)
    return dst


@pytest.fixture
def mocks():
    return create_mocks_app(identity_key=KEY)


@pytest.fixture
def make_client(root: Path, tmp_path: Path, mocks):
    clients: list[TestClient] = []

    def factory(**overrides) -> TestClient:
        options = {
            "root": root,
            "data_dir": tmp_path / f"data{len(clients)}",
            "pat_service_url": "http://mocks/pat",
            "mock_base": "http://mocks",
            "identity_key": KEY,
            "portal_origins": [PORTAL],
            "rate_limit": 1000,
            **overrides,
        }
        settings = load_settings(**options)
        c = TestClient(create_app(settings, transport=RoutingTransport(mocks)))
        c.__enter__()
        clients.append(c)
        return c

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


@pytest.fixture
def state(mocks):
    return mocks.state.mock


def login(client: TestClient, user: str) -> None:
    client.cookies.clear()
    r = client.post("/auth/dev-login", json={"user": user})
    assert r.status_code == 200, r.text


def ext(name: str) -> dict[str, str]:
    return {"X-Harbor-Extension": name}


def pat(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
