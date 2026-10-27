"""Harbor CLI (prototype): a person or agent calls connectors through the same gateway using a PAT.

  export HARBOR_URL=http://127.0.0.1:8000  HARBOR_PAT=pat_alice_cli
  python -m harbor_platform.cli connectors
  python -m harbor_platform.cli call jira GET "/rest/api/2/search?jql=project = PAY"
  python -m harbor_platform.cli call jira POST /rest/api/2/issue/PAY-101/comment --data '{"body":"Verified"}'

On denial, prints the reason and required permissions returned by the gateway so users can request access and agents can self-repair.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from urllib.parse import quote

import httpx


def _client() -> httpx.Client:
    pat = os.environ.get("HARBOR_PAT")
    if not pat:
        sys.exit("Please set the HARBOR_PAT environment variable")
    return httpx.Client(
        base_url=os.environ.get("HARBOR_URL", "http://127.0.0.1:8000"),
        headers={"Authorization": f"Bearer {pat}"},
        timeout=30,
    )


def _print_response(r: httpx.Response) -> int:
    err = r.headers.get("x-harbor-gateway-error")
    if err:
        body = r.json()
        print(f"Gateway denied ({r.status_code} {err}): {body.get('reason')}", file=sys.stderr)
        if body.get("need"):
            print(f"Needs: {', '.join(body['need'])}", file=sys.stderr)
        return 1
    try:
        print(json.dumps(r.json(), ensure_ascii=False, indent=2))
    except ValueError:
        print(r.text)
    return 0 if r.is_success else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="harbor", description="Harbor gateway CLI (prototype)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("me", help="Identity and AD groups for the current credential")
    sub.add_parser("connectors", help="Connector catalog: capabilities, required AD groups, whether I have them")
    call = sub.add_parser("call", help="Call an upstream system through the gateway passthrough")
    call.add_argument("connector")
    call.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    call.add_argument("path", help="upstream path, may include a query string")
    call.add_argument("--data", help="JSON request body")
    args = ap.parse_args(argv)

    with _client() as c:
        if args.cmd == "me":
            return _print_response(c.get("/api/me"))
        if args.cmd == "connectors":
            r = c.get("/api/connectors")
            if r.headers.get("x-harbor-gateway-error"):
                return _print_response(r)
            for conn in r.json()["items"]:
                print(f"{conn['name']}  {conn['title']} — {conn['description']}")
                for cap in conn["capabilities"]:
                    mark = "✓" if cap["user_has_access"] and cap["open"] else "✗"
                    flags = (" [write]" if cap["write"] else "") + ("" if cap["open"] else f" [{cap['data_class']}, not open]")
                    print(f"  {mark} {cap['id']}{flags}  groups: {', '.join(cap['groups'])}  {cap['description']}")
            return 0
        path = args.path if args.path.startswith("/") else "/" + args.path
        path = quote(path, safe="/?&=%:@,;+!$'()*~-._")
        headers = {"Content-Type": "application/json"} if args.data else {}
        return _print_response(c.request(args.method, f"/gw/{args.connector}{path}", content=args.data, headers=headers))


if __name__ == "__main__":
    sys.exit(main())
