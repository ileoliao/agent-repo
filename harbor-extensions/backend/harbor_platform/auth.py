"""Authentication: every credential (PAT or browser session) is introspected by the PAT service, with the result cached briefly.

The cache has two purposes:
  * performance: no need to call the PAT service on every request; AD group changes take effect after at most introspect_ttl seconds;
  * resilience: if the PAT service is briefly unavailable, cached identities stay usable for introspect_stale seconds.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class Principal:
    user: str
    display_name: str
    groups: frozenset[str]
    scopes: frozenset[str]
    kind: str  # "pat" | "session"


class AuthUnavailable(Exception):
    pass


class Introspector:
    MAX_ENTRIES = 10_000

    def __init__(self, client: httpx.AsyncClient, base_url: str, ttl: float, stale: float) -> None:
        self._client = client
        self._url = base_url.rstrip("/") + "/introspect"
        self._ttl = ttl
        self._stale = stale
        # key -> (fresh_until, stale_until, principal | None)
        self._cache: dict[str, tuple[float, float, Principal | None]] = {}

    @staticmethod
    def _key(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def forget(self, token: str) -> None:
        self._cache.pop(self._key(token), None)

    def _prune(self, now: float) -> None:
        if len(self._cache) > self.MAX_ENTRIES:
            for k in [k for k, v in self._cache.items() if v[1] <= now]:
                del self._cache[k]

    async def principal(self, token: str) -> Principal | None:
        key = self._key(token)
        now = time.monotonic()
        self._prune(now)
        hit = self._cache.get(key)
        if hit and hit[0] > now:
            return hit[2]
        try:
            r = await self._client.post(self._url, json={"token": token}, timeout=5)
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError) as exc:
            if hit and hit[2] is not None and hit[1] > now:
                return hit[2]
            raise AuthUnavailable("PAT service unavailable") from exc

        principal: Principal | None = None
        ttl = 5.0  # invalid credentials are cached only briefly
        if data.get("active"):
            principal = Principal(
                user=str(data["user"]),
                display_name=str(data.get("display_name", data["user"])),
                groups=frozenset(data.get("groups") or []),
                scopes=frozenset(data.get("scopes") or []),
                kind=str(data.get("kind", "pat")),
            )
            ttl = self._ttl
            if data.get("exp"):
                ttl = max(0.0, min(ttl, float(data["exp"]) - time.time()))
        self._cache[key] = (now + ttl, now + ttl + (self._stale if principal else 0), principal)
        return principal

