"""Harbor Extensions platform: gateway + extension host. The platform stores no business data.

Routes
  /gw/{connector}/{path}     Passthrough gateway: authorizes, then forwards the request unchanged to the upstream system
  /api/...                   Platform APIs for the portal and SDK (me, extension catalog, connector catalog, can, audit)
  /auth/...                  Simulated login for development
  /ext/{name}/...            Extension static files (sandbox CSP enforced)
  /sdk/...                   harbor.js / harbor.css
  /                          Portal (React build output)
"""

from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

from .auth import AuthUnavailable, Introspector, Principal
from .authz import authorize, check_extension_access
from .config import Settings, load_settings
from .extensions import Extension
from .observe import Audit, RateLimiter
from .paths import BadPath, check_path
from .registry import Registry

GATEWAY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
# Only semantic headers are forwarded; Cookie, Authorization, Host etc. are never forwarded
REQUEST_HEADERS = ("accept", "accept-language", "content-type", "if-match", "if-none-match")
RESPONSE_HEADERS = ("content-type", "etag", "last-modified", "cache-control", "x-total-count")
ADMIN_GROUP = "APP-PLATFORM-ADMIN"
RESERVED_PREFIXES = ("api/", "gw/", "ext/", "sdk/", "auth/")

# Extension pages: sandboxed, no network access of their own, embeddable only in the portal
EXTENSION_CSP = "; ".join(
    [
        # Matches the portal iframe's sandbox attribute; also applies when the extension URL is opened directly
        "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox",
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
    ]
)
PORTAL_CSP = "; ".join(
    [
        "default-src 'self'",
        "frame-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    ]
)


class GatewayError(Exception):
    def __init__(self, status: int, code: str, reason: str, need: list[str] | None = None) -> None:
        super().__init__(reason)
        self.status, self.code, self.reason, self.need = status, code, reason, need or []


@dataclass(frozen=True)
class Context:
    principal: Principal
    extension: Extension | None
    via: str  # "cookie" | "bearer"
    request_id: str


class LoginBody(BaseModel):
    user: str


def identity_token(settings: Settings, ctx: Context, audience: str, capability: str) -> str:
    """Identity claim the gateway issues to downstream systems. HS256 in the prototype; asymmetric keys verified via JWKS in production."""
    now = int(time.time())
    claims = {
        "iss": "harbor-gateway",
        "aud": audience,
        "sub": ctx.principal.user,
        "name": ctx.principal.display_name,
        "ext": ctx.extension.name if ctx.extension else None,
        "cap": capability,
        "via": ctx.principal.kind,
        "rid": ctx.request_id,
        "iat": now,
        "exp": now + 60,
    }
    return jwt.encode(claims, settings.identity_key, algorithm="HS256")


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or load_settings()
    registry = Registry(settings)
    audit = Audit(settings.data_dir / "audit.log")
    limiter = RateLimiter(settings.rate_limit, settings.rate_window)
    runtime: dict[str, Any] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = httpx.AsyncClient(transport=transport, follow_redirects=False)
        runtime["client"] = client
        runtime["introspector"] = Introspector(
            client, settings.pat_service_url, settings.introspect_ttl, settings.introspect_stale
        )
        yield
        await client.aclose()

    app = FastAPI(
        title="Harbor Extensions platform (prototype)",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.runtime = runtime

    # ------------------------------------------------------------------ common

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        rid = uuid.uuid4().hex[:16]
        request.state.rid = rid
        response = await call_next(request)
        response.headers["X-Request-Id"] = rid
        return response

    @app.exception_handler(GatewayError)
    async def gateway_error(request: Request, exc: GatewayError) -> JSONResponse:
        return JSONResponse(
            {
                "error": exc.code,
                "reason": exc.reason,
                "need": exc.need,
                "request_id": getattr(request.state, "rid", None),
            },
            status_code=exc.status,
            headers={"X-Harbor-Gateway-Error": exc.code},
        )

    def check_origin(request: Request) -> None:
        origin = request.headers.get("origin")
        if origin is not None and origin not in settings.portal_origins:
            raise GatewayError(403, "bad_origin", f"Requests from {origin} are not accepted")

    async def resolve(request: Request, *, require_extension: bool) -> Context:
        check_origin(request)
        token, via = None, None
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            token, via = header[7:].strip(), "bearer"
        elif settings.session_cookie in request.cookies:
            token, via = request.cookies[settings.session_cookie], "cookie"
        if not token:
            raise GatewayError(401, "unauthenticated", "Missing credentials: sign in to the portal, or use a PAT (Authorization: Bearer <PAT>)")
        try:
            principal = await runtime["introspector"].principal(token)
        except AuthUnavailable as exc:
            raise GatewayError(503, "auth_unavailable", "The PAT service is temporarily unavailable, please retry shortly") from exc
        if principal is None:
            raise GatewayError(401, "invalid_token", "Credentials are invalid or expired")

        ext = None
        ext_name = request.headers.get("x-harbor-extension")
        if ext_name:
            ext = registry.extensions.get(ext_name)
            if ext is None:
                raise GatewayError(404, "unknown_extension", f"Extension {ext_name} does not exist")
        # Browser sessions may use the gateway only via an extension bridge in the portal; the custom header also guards against CSRF
        if require_extension and ext is None and via == "cookie":
            raise GatewayError(400, "extension_required", "Browser gateway requests must come from an extension (X-Harbor-Extension missing)")
        return Context(principal, ext, via, request.state.rid)

    def audit_base(ctx: Context) -> dict[str, Any]:
        return {
            "request_id": ctx.request_id,
            "user": ctx.principal.user,
            "credential": ctx.principal.kind,
            "extension": ctx.extension.name if ctx.extension else None,
        }

    # ------------------------------------------------------------------ passthrough gateway

    @app.api_route("/gw/{connector_name}/{path:path}", methods=GATEWAY_METHODS)
    async def gateway(request: Request, connector_name: str, path: str) -> Response:
        started = time.perf_counter()
        ctx = await resolve(request, require_extension=True)
        connector = registry.connectors.get(connector_name)
        if connector is None:
            raise GatewayError(404, "unknown_connector", f"Connector {connector_name} is not registered")

        raw = request.scope.get("raw_path", b"").decode("latin-1")
        prefix = f"/gw/{connector_name}"
        raw_path = raw[len(prefix):] if raw.startswith(prefix) else "/" + path
        method = request.method
        base = {**audit_base(ctx), "connector": connector.name, "method": method}
        try:
            forward_path, match_path = check_path(raw_path)
        except BadPath as exc:
            audit.record(**base, path=raw_path, decision="deny", code="bad_path")
            raise GatewayError(400, "bad_path", str(exc)) from exc

        cap = connector.match(method, match_path)
        base.update(path=match_path, capability=cap.id if cap else None)
        decision = authorize(
            ctx.principal, ctx.extension, cap, connector.name, settings.allowed_data_classes, registry.grants
        )
        if not decision.allowed:
            audit.record(**base, decision="deny", code=decision.code)
            raise GatewayError(403, decision.code, decision.reason, decision.need)
        assert cap is not None

        if not limiter.allow((ctx.principal.user, base["extension"] or "-", connector.name)):
            audit.record(**base, decision="deny", code="rate_limited")
            raise GatewayError(429, "rate_limited", f"Too many requests: at most {settings.rate_limit} per {settings.rate_window:g} seconds")

        body = await request.body()
        if len(body) > settings.max_body_bytes:
            raise GatewayError(413, "body_too_large", "Request body too large")

        headers = {k: v for k in REQUEST_HEADERS if (v := request.headers.get(k))}
        if connector.auth_type == "service-account":
            secret = settings.secrets.get(connector.auth_secret or "")
            if not secret:
                raise GatewayError(500, "connector_misconfigured", f"Credentials for connector {connector.name} are not configured")
            headers["Authorization"] = f"Bearer {secret}"
        headers["X-Harbor-Identity"] = identity_token(settings, ctx, connector.name, cap.id)
        headers["X-Request-Id"] = ctx.request_id

        url = connector.upstream.rstrip("/") + forward_path
        if request.url.query:
            url += "?" + request.url.query
        try:
            upstream = await runtime["client"].request(
                method, url, content=body or None, headers=headers, timeout=settings.upstream_timeout
            )
        except httpx.HTTPError as exc:
            audit.record(**base, decision="allow", status=502, code="upstream_unavailable")
            raise GatewayError(502, "upstream_unavailable", f"The upstream system for connector {connector.name} is unavailable") from exc

        out = {k: upstream.headers[k] for k in RESPONSE_HEADERS if k in upstream.headers}
        out["X-Harbor-Capability"] = cap.id
        audit.record(
            **base,
            decision="allow",
            status=upstream.status_code,
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
        )
        return Response(content=upstream.content, status_code=upstream.status_code, headers=out)

    # ------------------------------------------------------------------ platform APIs

    def extension_view(ext: Extension, principal: Principal) -> dict[str, Any]:
        caps = []
        for cap_id in ext.capabilities:
            cap = registry.capability(cap_id)
            granted = cap is not None and (not cap.write or cap_id in registry.grants.get(ext.name, frozenset()))
            caps.append(
                {
                    "id": cap_id,
                    "description": cap.description if cap else "(capability not registered)",
                    "write": bool(cap and cap.write),
                    "granted": granted,
                    "user_has_access": bool(cap and cap.groups & principal.groups),
                    "groups": sorted(cap.groups) if cap else [],
                }
            )
        return {
            "name": ext.name,
            "title": ext.title,
            "description": ext.description,
            "owner": ext.owner,
            "contact": ext.contact,
            "tier": ext.tier,
            "entry": f"/ext/{ext.name}/{ext.entry}",
            "capabilities": caps,
        }

    @app.get("/api/me")
    async def me(request: Request) -> dict[str, Any]:
        ctx = await resolve(request, require_extension=False)
        p = ctx.principal
        return {"user": p.user, "display_name": p.display_name, "groups": sorted(p.groups), "credential": p.kind}

    @app.get("/api/extensions")
    async def list_extensions(request: Request) -> dict[str, Any]:
        ctx = await resolve(request, require_extension=False)
        items = [
            extension_view(e, ctx.principal)
            for e in registry.extensions.values()
            if check_extension_access(ctx.principal, e).allowed
        ]
        return {"items": items}

    @app.get("/api/extensions/{name}")
    async def get_extension(request: Request, name: str) -> dict[str, Any]:
        ctx = await resolve(request, require_extension=False)
        ext = registry.extensions.get(name)
        if ext is None:
            raise GatewayError(404, "unknown_extension", f"Extension {name} does not exist")
        d = check_extension_access(ctx.principal, ext)
        if not d.allowed:
            raise GatewayError(403, d.code, d.reason, d.need)
        return extension_view(ext, ctx.principal)

    @app.get("/api/connectors")
    async def list_connectors(request: Request) -> dict[str, Any]:
        ctx = await resolve(request, require_extension=False)
        groups = ctx.principal.groups
        return {
            "items": [
                {
                    "name": c.name,
                    "title": c.title,
                    "description": c.description,
                    "owner": c.owner,
                    "capabilities": [
                        {
                            **cap.summary(),
                            "open": cap.data_class in settings.allowed_data_classes,
                            "user_has_access": bool(cap.groups & groups),
                        }
                        for cap in c.capabilities.values()
                    ],
                }
                for c in registry.connectors.values()
            ]
        }

    @app.get("/api/can")
    async def can(request: Request, connector: str, capability: str) -> dict[str, Any]:
        ctx = await resolve(request, require_extension=True)
        cap_id = capability if capability.startswith(f"{connector}.") else f"{connector}.{capability}"
        cap = registry.capability(cap_id)
        if cap is None:
            return {"allowed": False, "code": "unknown_capability", "reason": f"Capability {cap_id} does not exist", "need": []}
        return authorize(
            ctx.principal, ctx.extension, cap, connector, settings.allowed_data_classes, registry.grants
        ).as_dict()

    @app.get("/api/audit")
    async def get_audit(request: Request, limit: int = 200) -> dict[str, Any]:
        ctx = await resolve(request, require_extension=False)
        if ADMIN_GROUP not in ctx.principal.groups:
            raise GatewayError(403, "missing_group", f"Requires membership of AD group {ADMIN_GROUP}", [ADMIN_GROUP])
        return {"items": audit.recent(min(limit, 1000))}

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "config_errors": registry.errors}

    # ------------------------------------------------------------------ development login (simulated SSO)

    @app.get("/api/dev/users")
    async def dev_users() -> Any:
        if not settings.dev_login:
            raise GatewayError(404, "not_found", "Development login is disabled")
        r = await runtime["client"].get(settings.pat_service_url.rstrip("/") + "/users", timeout=5)
        return r.json()

    @app.post("/auth/dev-login")
    async def dev_login(request: Request, body: LoginBody) -> JSONResponse:
        check_origin(request)
        if not settings.dev_login:
            raise GatewayError(404, "not_found", "Development login is disabled")
        r = await runtime["client"].post(
            settings.pat_service_url.rstrip("/") + "/session", json={"user": body.user}, timeout=5
        )
        if r.status_code != 200:
            raise GatewayError(400, "login_failed", f"User {body.user} does not exist")
        resp = JSONResponse({"ok": True})
        resp.set_cookie(
            settings.session_cookie,
            r.json()["token"],
            httponly=True,
            samesite="strict",
            secure=settings.cookie_secure,
            path="/",
            max_age=8 * 3600,
        )
        return resp

    @app.post("/auth/logout")
    async def logout(request: Request) -> JSONResponse:
        """Sign out: revoke the session at the PAT service and clear the gateway cache, so an intercepted old cookie stops working immediately."""
        check_origin(request)
        token = request.cookies.get(settings.session_cookie)
        if token:
            runtime["introspector"].forget(token)
            try:
                await runtime["client"].post(
                    settings.pat_service_url.rstrip("/") + "/revoke", json={"token": token}, timeout=5
                )
            except httpx.HTTPError:
                pass  # the session still expires on schedule; the cookie is deleted regardless
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(settings.session_cookie, path="/")
        return resp

    # ------------------------------------------------------------------ static files

    ext_headers = {
        "Content-Security-Policy": EXTENSION_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-cache",
    }

    @app.get("/ext/{name}/{file_path:path}")
    def extension_file(name: str, file_path: str) -> FileResponse:
        ext = registry.extensions.get(name)
        if ext is None:
            raise GatewayError(404, "not_found", "Extension not found")
        root = ext.path.resolve()
        target = (root / (file_path or ext.entry)).resolve()
        if not target.is_relative_to(root) or not target.is_file() or target.name == "extension.yaml":
            raise GatewayError(404, "not_found", "File not found")
        return FileResponse(target, headers=ext_headers)

    @app.get("/sdk/{file_name}")
    def sdk_file(file_name: str) -> FileResponse:
        root = settings.sdk_dir.resolve()
        target = (root / file_name).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise GatewayError(404, "not_found", "File not found")
        return FileResponse(target, headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"})

    portal_headers = {"Content-Security-Policy": PORTAL_CSP, "X-Content-Type-Options": "nosniff"}

    @app.get("/{full_path:path}", include_in_schema=False)
    def portal(full_path: str) -> Response:
        if full_path.startswith(RESERVED_PREFIXES):
            raise GatewayError(404, "not_found", "Endpoint not found")
        dist = settings.portal_dist.resolve()
        if not (dist / "index.html").is_file():
            return HTMLResponse("Portal not built yet: cd portal && npm install && npm run build", status_code=503)
        target = (dist / full_path).resolve()
        if full_path and target.is_relative_to(dist) and target.is_file():
            return FileResponse(target, headers=portal_headers)
        return FileResponse(dist / "index.html", headers={**portal_headers, "Cache-Control": "no-cache"})

    return app
