"""Read-back through Grafana's datasource proxy: the same route, auth and tenant
configuration that people use when they query in Grafana."""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request


class QueryError(RuntimeError):
    pass


class Grafana:
    def __init__(self, url: str, token: str, ca_file: str | None = None, timeout: float = 10.0):
        self.url, self.token, self.timeout = url.rstrip("/"), token, timeout
        self.ctx = ssl.create_default_context(cafile=ca_file) if ca_file else None

    def _get(self, ds_uid: str, path: str, params: dict | None = None):
        q = f"?{urllib.parse.urlencode(params)}" if params else ""
        url = f"{self.url}/api/datasources/proxy/uid/{urllib.parse.quote(ds_uid)}{path}{q}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}",
                                                   "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise QueryError(f"HTTP {e.code} from Grafana proxy") from e
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            raise QueryError(f"{type(e).__name__}: {e}") from e

    def loki_count(self, ds_uid: str, logql: str, start_s: float, end_s: float) -> int:
        """Number of log lines matching `logql` in [start, end]."""
        body = self._get(ds_uid, "/loki/api/v1/query_range", {
            "query": logql, "start": str(int(start_s * 1e9)), "end": str(int(end_s * 1e9)),
            "limit": "5000", "direction": "forward"})
        if not body:
            return 0
        if body.get("status") not in (None, "success"):
            raise QueryError(f"Loki status {body.get('status')}: {body.get('error', '')}")
        return sum(len(s.get("values") or []) for s in (body.get("data") or {}).get("result") or [])

    def tempo_span_count(self, ds_uid: str, path: str) -> int | None:
        """Spans in the trace at `path`; None while Tempo does not know the trace yet."""
        body = self._get(ds_uid, path)
        if body is None:
            return None
        return _count_spans(body)


def _count_spans(node) -> int:
    """Count span objects in Tempo's OTLP-JSON trace (v1 'batches' or v2 'trace' shape)."""
    if isinstance(node, dict):
        own = 1 if "spanId" in node and "name" in node else 0
        return own + sum(_count_spans(v) for v in node.values())
    if isinstance(node, list):
        return sum(_count_spans(v) for v in node)
    return 0
