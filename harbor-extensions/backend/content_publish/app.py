"""Harbor content-publish API (sim / platform-shaped).

POST /api/content/extensions accepts the same JSON body as cli/commands/publish.mjs
and syncs decoded files into s3://harbor-content/extensions/<name>/ via rclone.

Auth (sim): Authorization: Bearer <token> required; token length must be >= 8
(convention: tokens start with pat_). Missing or short tokens → 401.
"""

from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse

app = FastAPI(title="harbor-content-publish", docs_url=None, redoc_url=None)

NAME_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
BUCKET = os.environ.get("CONTENT_BUCKET", "harbor-content")
S3_ENDPOINT = os.environ.get(
    "S3_ENDPOINT", "http://minio-fuse.harbor.svc.cluster.local:9000"
)
MIN_TOKEN_LEN = 8


def _require_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing Bearer token")
    token = authorization[7:].strip()
    # Sim: any Bearer token of length >= 8 (convention: pat_…).
    if len(token) < MIN_TOKEN_LEN:
        raise HTTPException(status_code=401, detail="invalid Bearer token")
    return token


def _rclone_env() -> dict[str, str]:
    user = os.environ.get("MINIO_ROOT_USER") or ""
    password = os.environ.get("MINIO_ROOT_PASSWORD") or ""
    if not user or not password:
        raise HTTPException(status_code=500, detail="object-store credentials not configured")
    env = os.environ.copy()
    env.update(
        {
            "RCLONE_CONFIG_S3_TYPE": "s3",
            "RCLONE_CONFIG_S3_PROVIDER": "Minio",
            "RCLONE_CONFIG_S3_ENV_AUTH": "false",
            "RCLONE_CONFIG_S3_ACCESS_KEY_ID": user,
            "RCLONE_CONFIG_S3_SECRET_ACCESS_KEY": password,
            "RCLONE_CONFIG_S3_ENDPOINT": S3_ENDPOINT,
            "RCLONE_CONFIG_S3_FORCE_PATH_STYLE": "true",
            "RCLONE_CONFIG_S3_ACL": "private",
        }
    )
    return env


def _sync_dir(local_dir: Path, name: str) -> None:
    dest = f"s3:{BUCKET}/extensions/{name}/"
    env = _rclone_env()
    # Ensure bucket exists, then sync the extension prefix.
    subprocess.run(
        ["rclone", "mkdir", f"s3:{BUCKET}"],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    proc = subprocess.run(
        [
            "rclone",
            "sync",
            "--checksum",
            f"{local_dir}/",
            dest,
            "--create-empty-src-dirs",
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "rclone sync failed")[:400]
        raise HTTPException(status_code=500, detail=detail)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "ok"


@app.get("/api/content/healthz", response_class=PlainTextResponse)
def content_healthz() -> str:
    """Same probe under the Ingress /api/content prefix."""
    return "ok"


@app.post("/api/content/extensions")
async def publish_extension(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_bearer(authorization)
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="invalid JSON body") from exc

    name = payload.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="invalid name")

    files = payload.get("files") or {}
    if not isinstance(files, dict) or not files:
        raise HTTPException(status_code=400, detail="no files")

    tmp = Path(tempfile.mkdtemp(prefix=f"harbor-pub-{name}-"))
    try:
        for rel, b64 in files.items():
            if not isinstance(rel, str) or ".." in rel or rel.startswith("/"):
                raise HTTPException(status_code=400, detail=f"bad path {rel!r}")
            if not isinstance(b64, str):
                raise HTTPException(status_code=400, detail=f"bad file body for {rel}")
            abs_path = tmp / rel
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                abs_path.write_bytes(base64.b64decode(b64, validate=False))
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=400, detail=f"bad base64 for {rel}") from exc
        _sync_dir(tmp, name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    prefix = payload.get("prefix") or f"extensions/{name}"
    return {"ok": True, "name": name, "files": len(files), "prefix": prefix}
