"""Rate limiting and auditing.

Audit record fields follow OTel attribute naming, so in production they can be sent to the OTel Collector as span attributes;
the prototype writes a JSON Lines file and keeps recent records in memory for the portal audit page.
"""

from __future__ import annotations

import json
import threading
import time
from collections import defaultdict, deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class RateLimiter:
    def __init__(self, limit: int, window: float) -> None:
        self.limit = limit
        self.window = window
        self._hits: dict[tuple[str, ...], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: tuple[str, ...]) -> bool:
        now = time.monotonic()
        with self._lock:
            if len(self._hits) > 50_000:  # drop keys outside the window to avoid unbounded memory growth
                for k in [k for k, q in self._hits.items() if not q or q[-1] <= now - self.window]:
                    del self._hits[k]
            q = self._hits[key]
            while q and q[0] <= now - self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True


class Audit:
    def __init__(self, path: Path, keep: int = 2000) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._recent: deque[dict[str, Any]] = deque(maxlen=keep)
        self._lock = threading.Lock()

    def record(self, **fields: Any) -> None:
        entry = {"ts": datetime.now(UTC).isoformat(timespec="milliseconds"), **fields}
        with self._lock:
            self._recent.append(entry)
            with self._path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def recent(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            return list(reversed(self._recent))[:limit]
