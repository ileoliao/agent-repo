"""Test doubles: an OTLP/HTTP receiver that stores what it decodes, and a
Grafana datasource proxy that answers Loki / Tempo queries from that store."""

from __future__ import annotations

import json
import re
import socket
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest, ExportLogsServiceResponse)
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
    ExportMetricsServiceRequest, ExportMetricsServiceResponse)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest, ExportTraceServiceResponse)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _any(v):
    kind = v.WhichOneof("value")
    return getattr(v, kind) if kind else None


def _attrs(kvs) -> dict:
    return {a.key: _any(a.value) for a in kvs}


class FakeOtlp:
    """Tenants are told apart by their Authorization header, like Nginx Basic auth."""

    def __init__(self, auth_to_tenant: dict):
        self.auth_to_tenant = auth_to_tenant
        self.lock = threading.Lock()
        self.metrics, self.logs, self.spans = [], [], []
        self.rejected = 0
        store = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                tenant = store.auth_to_tenant.get(self.headers.get("Authorization"))
                body = self.rfile.read(int(self.headers["Content-Length"]))
                if tenant is None:
                    store.rejected += 1
                    self.send_response(401)
                    self.end_headers()
                    return
                if self.path == "/v1/metrics":
                    req, resp = ExportMetricsServiceRequest(), ExportMetricsServiceResponse()
                    req.ParseFromString(body)
                    store._metrics(tenant, req)
                elif self.path == "/v1/logs":
                    req, resp = ExportLogsServiceRequest(), ExportLogsServiceResponse()
                    req.ParseFromString(body)
                    store._logs(tenant, req)
                elif self.path == "/v1/traces":
                    req, resp = ExportTraceServiceRequest(), ExportTraceServiceResponse()
                    req.ParseFromString(body)
                    store._spans(tenant, req)
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                out = resp.SerializeToString()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-protobuf")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        self.port = free_port()
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _metrics(self, tenant, req):
        with self.lock:
            for rm in req.resource_metrics:
                res = _attrs(rm.resource.attributes)
                for sm in rm.scope_metrics:
                    for m in sm.metrics:
                        kind = m.WhichOneof("data")
                        for dp in getattr(m, kind).data_points:
                            if kind == "histogram":
                                v = (dp.count, dp.sum, list(dp.explicit_bounds))
                            else:
                                v = dp.as_int if dp.HasField("as_int") else dp.as_double
                            self.metrics.append({"tenant": tenant, "name": m.name, "kind": kind,
                                                 "unit": m.unit, "value": v,
                                                 "attrs": _attrs(dp.attributes), "resource": res})

    def _logs(self, tenant, req):
        with self.lock:
            for rl in req.resource_logs:
                res = _attrs(rl.resource.attributes)
                for sl in rl.scope_logs:
                    for r in sl.log_records:
                        self.logs.append({"tenant": tenant, "body": _any(r.body),
                                          "attrs": _attrs(r.attributes), "resource": res})

    def _spans(self, tenant, req):
        with self.lock:
            for rs in req.resource_spans:
                for ss in rs.scope_spans:
                    for s in ss.spans:
                        self.spans.append({"tenant": tenant, "trace_id": s.trace_id.hex(),
                                           "span_id": s.span_id.hex(), "name": s.name,
                                           "attrs": _attrs(s.attributes)})


class FakeGrafana:
    """Datasource proxy backed by FakeOtlp. Loki structured metadata is modelled as
    OTel attribute names with dots replaced by underscores, as Loki's OTLP ingest does."""

    def __init__(self, otlp: FakeOtlp, token: str, uid_to_tenant: dict, delay_lines: int = 0):
        self.otlp, self.token, self.uid_to_tenant = otlp, token, uid_to_tenant
        self.queries = []
        self.hide = delay_lines   # pretend this many matching lines are not indexed yet
        g = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _json(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.headers.get("Authorization") != f"Bearer {g.token}":
                    return self._json(401, {"message": "unauthorized"})
                u = urllib.parse.urlparse(self.path)
                m = re.match(r"^/api/datasources/proxy/uid/([^/]+)(/.*)$", u.path)
                if not m or m.group(1) not in g.uid_to_tenant:
                    return self._json(404, {"message": "no datasource"})
                tenant, sub = g.uid_to_tenant[m.group(1)], m.group(2)
                q = urllib.parse.parse_qs(u.query)
                g.queries.append((m.group(1), sub, q))
                if sub == "/loki/api/v1/query_range":
                    return self._json(200, g._loki(tenant, q["query"][0]))
                t = re.match(r"^/api/traces/([0-9a-f]{32})$", sub)
                if t:
                    spans = [s for s in g.otlp.spans if s["tenant"] == tenant and s["trace_id"] == t.group(1)]
                    if not spans:
                        return self._json(404, {"error": "trace not found"})
                    return self._json(200, {"batches": [{"scopeSpans": [{"spans": [
                        {"spanId": s["span_id"], "name": s["name"]} for s in spans]}]}]})
                return self._json(404, {"message": "not found"})

        self.port = free_port()
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _loki(self, tenant, logql):
        filters = dict(re.findall(r'\|\s*(\w+)="([^"]*)"', logql))
        with self.otlp.lock:
            rows = [r for r in self.otlp.logs if r["tenant"] == tenant and all(
                str(r["attrs"].get(k.replace("probe_", "probe.", 1), "")) == v for k, v in filters.items())]
        rows = rows[self.hide:]
        return {"status": "success", "data": {"resultType": "streams", "result": [
            {"stream": {"service_name": "heartbeat-probe"},
             "values": [["0", str(r["body"])] for r in rows]}] if rows else []}}
