"""Send one trace (normal + error span), one metric and one log per resource over OTLP/HTTP.

  python3 send.py <allowed-service> [endpoint]

Resources: the allowed service, near-misses of it, an unlisted name and one without service.name.
Prints the names that must pass, one per line.
"""
import json
import sys
import time
import urllib.request

allowed = sys.argv[1]
endpoint = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:14318"
near = {allowed + "x", allowed[:-1], allowed.swapcase(), "not-registered-svc"} - {allowed, ""}
services = [allowed, *sorted(near), None]
now = str(time.time_ns())


def resource(name):
    key, value = ("service.name", name) if name else ("host.name", "no-service-name")
    return {"attributes": [{"key": key, "value": {"stringValue": value}}]}


def span(i, error):
    s = {"traceId": f"{i + 1:032x}", "spanId": f"{i + 1:016x}", "name": "op",
         "startTimeUnixNano": now, "endTimeUnixNano": now}
    if error:
        s["status"] = {"code": 2}
    return s


bodies = {
    "traces": {"resourceSpans": [
        {"resource": resource(n), "scopeSpans": [{"scope": {}, "spans": [span(2 * i, False), span(2 * i + 1, True)]}]}
        for i, n in enumerate(services)]},
    "metrics": {"resourceMetrics": [
        {"resource": resource(n), "scopeMetrics": [{"scope": {}, "metrics": [
            {"name": "probe.value", "gauge": {"dataPoints": [{"asDouble": 1.0, "timeUnixNano": now}]}}]}]}
        for n in services]},
    "logs": {"resourceLogs": [
        {"resource": resource(n), "scopeLogs": [{"scope": {}, "logRecords": [
            {"timeUnixNano": now, "severityText": "ERROR", "body": {"stringValue": "probe"}}]}]}
        for n in services]},
}

for signal, body in bodies.items():
    req = urllib.request.Request(f"{endpoint}/v1/{signal}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()

print(allowed)
