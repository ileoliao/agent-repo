"""Extension definitions (extension.yaml) and write-capability grants (config/grants.yaml)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .connectors import CAP_KEY_RE, NAME_RE, ConfigError, Connector, split_capability_id

TIERS = ("experimental", "community", "official")
ALLOWED_FIELDS = {"name", "title", "description", "owner", "contact", "tier", "visibility", "capabilities", "entry"}


@dataclass(frozen=True)
class Extension:
    name: str
    title: str
    description: str
    owner: str
    contact: str
    tier: str
    visibility: frozenset[str]
    capabilities: tuple[str, ...]
    entry: str
    path: Path


def parse_extension(data: Any, directory: Path) -> Extension:
    source = f"extensions/{directory.name}/extension.yaml"

    def err(msg: str) -> ConfigError:
        return ConfigError(f"{source}: {msg}")

    if not isinstance(data, dict):
        raise err("top level must be a mapping")
    unknown = sorted(set(data) - ALLOWED_FIELDS)
    if unknown:
        raise err(f"Unknown field {', '.join(map(str, unknown))} (allowed: {', '.join(sorted(ALLOWED_FIELDS))})")
    name = data.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise err("name must be lowercase letters, digits and hyphens")
    if name != directory.name:
        raise err(f"name must match the directory name ({directory.name})")
    for required in ("title", "owner"):
        if not data.get(required):
            raise err(f"Missing {required}")
    tier = data.get("tier", "experimental")
    if tier not in TIERS:
        raise err(f"tier must be one of {TIERS}")
    visibility = data.get("visibility")
    if not isinstance(visibility, list) or not visibility:
        raise err("visibility must list at least one AD group")
    caps = data.get("capabilities") or []
    if not isinstance(caps, list):
        raise err("capabilities must be a list")
    for cap_id in caps:
        connector, key = split_capability_id(str(cap_id))
        if not NAME_RE.match(connector) or not CAP_KEY_RE.match(key):
            raise err(f"Capability {cap_id!r} must be in the form <connector>.<capability>")
    entry = str(data.get("entry", "index.html"))
    entry_path = (directory / entry).resolve()
    if not entry_path.is_relative_to(directory.resolve()) or not entry_path.is_file():
        raise err(f"Entry file {entry} does not exist")
    return Extension(
        name=name,
        title=str(data["title"]),
        description=str(data.get("description", "")),
        owner=str(data["owner"]),
        contact=str(data.get("contact", "")),
        tier=tier,
        visibility=frozenset(str(g) for g in visibility),
        capabilities=tuple(str(c) for c in caps),
        entry=entry,
        path=directory,
    )


def load_extensions(directory: Path) -> tuple[dict[str, Extension], list[str]]:
    extensions: dict[str, Extension] = {}
    errors: list[str] = []
    for manifest in sorted(directory.glob("*/extension.yaml")):
        try:
            ext = parse_extension(yaml.safe_load(manifest.read_text(encoding="utf-8")), manifest.parent)
            extensions[ext.name] = ext
        except (ConfigError, yaml.YAMLError) as e:
            errors.append(str(e))
    return extensions, errors


def load_grants(path: Path) -> tuple[dict[str, frozenset[str]], list[str]]:
    if not path.exists():
        return {}, []
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        return {}, [f"config/grants.yaml: {e}"]
    grants: dict[str, frozenset[str]] = {}
    errors: list[str] = []
    if not isinstance(raw, dict):
        return {}, ["config/grants.yaml: top level must be a mapping"]
    for ext_name, items in raw.items():
        caps: set[str] = set()
        for item in items or []:
            if not isinstance(item, dict) or not item.get("capability") or not item.get("approved_by"):
                errors.append(f"config/grants.yaml: every grant for {ext_name} needs capability and approved_by")
                continue
            caps.add(str(item["capability"]))
        grants[str(ext_name)] = frozenset(caps)
    return grants, errors


def reference_errors(ext: Extension, connectors: dict[str, Connector]) -> list[str]:
    errors = []
    for cap_id in ext.capabilities:
        connector, key = split_capability_id(cap_id)
        if connector not in connectors:
            errors.append(f"Extension {ext.name}: connector {connector} is not registered")
        elif key not in connectors[connector].capabilities:
            errors.append(f"Extension {ext.name}: connector {connector} has no capability {key}")
    return errors
