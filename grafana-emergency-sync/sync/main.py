"""One-way sync from a primary to an independent emergency Grafana.

Uses the Grafana HTTP APIs. Never deletes resources on the destination.
Python standard library only; compatible with Python 3.11+.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen

LOGGER = logging.getLogger("grafana-emergency-sync")
PAGE_SIZE = 500


class SyncError(RuntimeError):
    pass


class ApiError(SyncError):
    def __init__(self, method: str, path: str, status: int, detail: str = ""):
        # No headers, auth tokens, or request JSON are included.
        super().__init__(f"{method} {path}: HTTP {status} {detail[:160]}")
        self.status = status


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SyncError(f"Required environment variable is missing: {name}")
    return value


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    return default if value is None else value.lower() in ("true", "1", "yes", "on")


def token_from_env(name: str) -> str:
    # Tokens are only read from env vars or a mounted secret file.
    direct = os.getenv(name, "")
    file = os.getenv(name + "_FILE", "")
    if direct and file:
        raise SyncError(f"Set only {name} or {name}_FILE")
    value = Path(file).read_text(encoding="utf8") if file else direct
    if not value.strip():
        raise SyncError(f"Missing token: {name} or {name}_FILE")
    return value.strip()


def secrets_file(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    try:
        obj = json.loads(Path(path).read_text(encoding="utf8"))
    except (OSError, ValueError) as exc:
        raise SyncError("Cannot parse DATA_SOURCE_SECRETS_FILE as JSON") from exc
    if not isinstance(obj, dict):
        raise SyncError("DATA_SOURCE_SECRETS_FILE must be a JSON object keyed by source UID")
    return obj


def ident(value: str) -> str:
    return quote(str(value), safe="")


class GrafanaClient:
    def __init__(self, url: str, token: str, timeout: float = 20):
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
            raise SyncError("Grafana URL must be an http(s) URL without embedded credentials")
        if parsed.scheme == "http" and not env_bool("ALLOW_HTTP", False):
            raise SyncError("Refusing plain HTTP. Use HTTPS or explicitly set ALLOW_HTTP=true for private in-cluster traffic")
        self.base = url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def call(self, method: str, path: str, payload: Any = None, extra_headers: dict | None = None) -> Any:
        if not path.startswith("/"):
            raise SyncError("API path must begin with /")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.token}"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers.update(extra_headers or {})
        req = Request(self.base + path, data=data, headers=headers, method=method)
        attempts = 3 if method == "GET" else 1
        for attempt in range(attempts):
            try:
                with urlopen(req, timeout=self.timeout) as response:
                    body = response.read()
                    return json.loads(body) if body else None
            except HTTPError as exc:
                try:
                    detail = exc.read(240).decode("utf-8", errors="replace")
                except Exception:
                    detail = ""
                # Don't log raw API response bodies: they can contain confidential settings.
                if exc.code in (429, 500, 502, 503, 504) and method == "GET" and attempt < attempts - 1:
                    time.sleep(1 + attempt)
                    continue
                raise ApiError(method, path.split("?")[0], exc.code) from exc
            except (URLError, TimeoutError, OSError) as exc:
                if method == "GET" and attempt < attempts - 1:
                    time.sleep(1 + attempt)
                    continue
                raise SyncError(f"Network error calling {method} {path.split('?')[0]} ({type(exc).__name__})") from exc
        raise SyncError("API retries exhausted")

    def maybe_get(self, path: str) -> Any:
        try:
            return self.call("GET", path)
        except ApiError as exc:
            if exc.status == 404:
                return None
            raise


@dataclass
class Options:
    dry_run: bool = True
    sync_alert_rules: bool = True
    datasource_secrets: dict[str, Any] | None = None


def page_list(source: GrafanaClient, path: str) -> list[dict]:
    """Fetch all legacy API pages; fail closed if pagination is inconsistent."""
    all_items: list[dict] = []
    seen: set[str] = set()
    for page in range(1, 1001):
        sep = "&" if "?" in path else "?"
        results = source.call("GET", f"{path}{sep}{urlencode({'limit': PAGE_SIZE, 'page': page})}")
        if not isinstance(results, list):
            raise SyncError(f"Invalid collection response from {path}")
        fingerprints = [str(x.get("uid", x.get("id", ""))) for x in results]
        if not all(fingerprints) or any(fp in seen for fp in fingerprints):
            raise SyncError(f"Invalid/repeated pagination results from {path}; stopping to avoid partial sync")
        seen.update(fingerprints)
        all_items.extend(results)
        if len(results) < PAGE_SIZE:
            return all_items
    raise SyncError(f"Pagination exceeded safety bound for {path}")


def snapshot(source: GrafanaClient, options: Options) -> dict[str, Any]:
    """Read all requested source resources BEFORE changing the destination."""
    health = source.call("GET", "/api/health")
    if not isinstance(health, dict) or health.get("database") != "ok":
        raise SyncError("Primary Grafana database health not OK; destination left unchanged")
    folders = page_list(source, "/api/folders")
    results = page_list(source, "/api/search?type=dash-db")
    datasources = source.call("GET", "/api/datasources")
    if not isinstance(datasources, list):
        raise SyncError("Invalid data source list; destination left unchanged")
    dashboards = []
    for entry in results:
        uid = entry.get("uid")
        if not uid:
            raise SyncError("Dashboard without UID; aborting")
        detail = source.call("GET", f"/api/dashboards/uid/{ident(uid)}")
        if not isinstance(detail, dict) or not isinstance(detail.get("dashboard"), dict):
            raise SyncError(f"Invalid dashboard payload for UID {uid}")
        dashboards.append(detail)
    rules = []
    if options.sync_alert_rules:
        rules = source.call("GET", "/api/v1/provisioning/alert-rules")
        if not isinstance(rules, list):
            raise SyncError("Invalid alert rules list; destination left unchanged")
        for rule in rules:
            if not rule.get("uid") or not rule.get("folderUID"):
                raise SyncError("Invalid alert rule: missing UID or folderUID")
    return {"folders": folders, "dashboards": dashboards, "datasources": datasources, "rules": rules}


def sort_folders(folders: list[dict]) -> list[dict]:
    """Topologically order nested folders, with cycle/missing-parent protection."""
    pending = {str(f["uid"]): f for f in folders}
    done: set[str] = set()
    ordered: list[dict] = []
    while pending:
        progress = False
        for uid, item in list(pending.items()):
            parent = item.get("parentUid") or ""
            if not parent or parent in done:
                ordered.append(item)
                done.add(uid)
                del pending[uid]
                progress = True
        if not progress:
            raise SyncError("Folder hierarchy has a cycle or missing parent; refusing partial sync")
    return ordered


def plan(source_state: dict[str, Any]) -> dict[str, Any]:
    folders = source_state["folders"]
    dashboards = source_state["dashboards"]
    datasources = source_state["datasources"]
    rules = source_state["rules"]
    for name, entries in (("folders", folders), ("datasources", datasources), ("dashboards", [d["dashboard"] for d in dashboards]), ("alert rules", rules)):
        uids = [x.get("uid") for x in entries]
        if any(not x for x in uids) or len(set(uids)) != len(uids):
            raise SyncError(f"Duplicate or missing UIDs in {name}; refusing partial sync")
    # Validation of all parent links before any destination writes.
    ordered = sort_folders(folders)
    folder_uids = {f["uid"] for f in folders}
    for item in dashboards:
        folder_uid = item.get("meta", {}).get("folderUid")
        if folder_uid and folder_uid not in folder_uids:
            raise SyncError(f"Dashboard refers to missing folder {folder_uid}")
    for rule in rules:
        if rule["folderUID"] not in folder_uids:
            raise SyncError(f"Alert rule refers to missing folder {rule['folderUID']}")
    return {**source_state, "folders": ordered}


def clean_datasource(item: dict, secure_fields: dict[str, str]) -> dict:
    allowed = (
        "uid", "name", "type", "access", "url", "user", "database", "basicAuth",
        "basicAuthUser", "withCredentials", "isDefault", "jsonData", "readOnly",
    )
    value = {k: copy.deepcopy(item[k]) for k in allowed if k in item and k != "readOnly"}
    if secure_fields:
        value["secureJsonData"] = secure_fields
    return value


def clean_alert_rule(item: dict) -> dict:
    allowed = (
        "uid", "title", "condition", "data", "folderUID", "ruleGroup", "noDataState",
        "execErrState", "for", "keepFiringFor", "annotations", "labels", "isPaused",
        "notification_settings", "record", "orgId",
    )
    return {k: copy.deepcopy(item[k]) for k in allowed if k in item}


def sync_all(target: GrafanaClient, state: dict[str, Any], options: Options) -> dict[str, int]:
    """Upsert in dependency order; do not delete resources or write to source."""
    counts = {"folders": 0, "datasources": 0, "dashboards": 0, "alert_rules": 0}
    secrets = options.datasource_secrets or {}
    # Fail closed on missing destination credentials BEFORE modifying any resource.
    # Reuse these destination API responses during the actual upsert loop.
    destination_datasources: dict[str, dict | None] = {}
    for src in state["datasources"]:
        uid = src["uid"]
        dst = target.maybe_get(f"/api/datasources/uid/{ident(uid)}")
        destination_datasources[uid] = dst
        supplied = secrets.get(uid, {})
        if not isinstance(supplied, dict):
            raise SyncError(f"Invalid datasource secret mapping for {uid}")
        missing = [
            key for key, enabled in (src.get("secureJsonFields") or {}).items()
            if enabled and key not in supplied
            and not (dst and (dst.get("secureJsonFields") or {}).get(key))
        ]
        if missing:
            raise SyncError(f"Data source {uid} requires destination secrets for fields: {', '.join(missing)}")
    for src in state["folders"]:
        uid = src["uid"]
        dst = target.maybe_get(f"/api/folders/{ident(uid)}")
        body = {"title": src["title"]}
        if src.get("parentUid"):
            body["parentUid"] = src["parentUid"]
        if not options.dry_run:
            if dst is None:
                target.call("POST", "/api/folders", {"uid": uid, **body})
            elif dst.get("title") != src["title"] or (dst.get("parentUid") or "") != (src.get("parentUid") or ""):
                target.call("PUT", f"/api/folders/{ident(uid)}", {**body, "version": dst.get("version", 0)})
        counts["folders"] += 1

    for src in state["datasources"]:
        uid = src["uid"]
        dst = destination_datasources[uid]
        supplied = secrets.get(uid, {})
        body = clean_datasource(src, supplied)
        if not options.dry_run:
            if dst is None:
                target.call("POST", "/api/datasources", body)
            elif supplied or any(dst.get(key) != value for key, value in body.items()):
                target.call("PUT", f"/api/datasources/uid/{ident(uid)}", body)
        counts["datasources"] += 1

    for item in state["dashboards"]:
        board = copy.deepcopy(item["dashboard"])
        uid = board["uid"]
        board["id"] = None  # Numeric IDs are database-local.
        board["version"] = 0  # Avoid conflicting source-side version numbers.
        body: dict[str, Any] = {"dashboard": board, "overwrite": True, "message": "Emergency sync"}
        folder_uid = item.get("meta", {}).get("folderUid")
        if folder_uid:
            body["folderUid"] = folder_uid
        existing = target.maybe_get(f"/api/dashboards/uid/{ident(uid)}")
        def comparable(board_data: dict) -> dict:
            value = copy.deepcopy(board_data)
            value.pop("id", None)
            value.pop("version", None)
            return value
        changed = (existing is None or not isinstance(existing.get("dashboard"), dict)
                   or comparable(existing["dashboard"]) != comparable(board)
                   or (existing.get("meta", {}).get("folderUid") or "") != (folder_uid or ""))
        if not options.dry_run and changed:
            target.call("POST", "/api/dashboards/db", body)
        counts["dashboards"] += 1

    for src in state["rules"]:
        uid = src["uid"]
        dst = target.maybe_get(f"/api/v1/provisioning/alert-rules/{ident(uid)}")
        body = clean_alert_rule(src)
        # The emergency instance is deployed with execution disabled at the process level.
        # Do not change rule isPaused state: retain the source state for later activation.
        if not options.dry_run:
            headers = {"X-Disable-Provenance": "true"}
            if dst is None:
                target.call("POST", "/api/v1/provisioning/alert-rules", body, headers)
            elif clean_alert_rule(dst) != body:
                target.call("PUT", f"/api/v1/provisioning/alert-rules/{ident(uid)}", body, headers)
        counts["alert_rules"] += 1
    return counts


def run() -> int:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    try:
        dry_run = env_bool("DRY_RUN", True)
        options = Options(
            dry_run=dry_run,
            sync_alert_rules=env_bool("SYNC_ALERT_RULES", True),
            datasource_secrets=secrets_file(os.getenv("DATA_SOURCE_SECRETS_FILE")),
        )
        source = GrafanaClient(required_env("SOURCE_GRAFANA_URL"), token_from_env("SOURCE_GRAFANA_TOKEN"))
        target = GrafanaClient(required_env("TARGET_GRAFANA_URL"), token_from_env("TARGET_GRAFANA_TOKEN"))
        if source.base == target.base:
            raise SyncError("Source and target URLs must differ")
        state = plan(snapshot(source, options))
        counts = sync_all(target, state, options)
        LOGGER.info("result=%s", json.dumps({"status": "ok", "dry_run": dry_run, **counts}))
        LOGGER.warning("Alert notification routing, contact points, group intervals, and secrets must be configured separately")
        return 0
    except SyncError as exc:
        LOGGER.error("Synchronization aborted: %s", exc)
        return 1
    except Exception as exc:
        LOGGER.exception("Unexpected synchronization error (%s)", type(exc).__name__)
        return 1


if __name__ == "__main__":
    sys.exit(run())
