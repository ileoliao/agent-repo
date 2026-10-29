"""Extension definitions (extension.yaml) and write-capability grants (config/grants.yaml)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import re

import yaml

from .connectors import CAP_KEY_RE, NAME_RE, ConfigError, Connector, split_capability_id

TIERS = ("experimental", "community", "official")
ALLOWED_FIELDS = {"name", "title", "description", "owner", "contact", "tier", "visibility", "capabilities", "entry", "nav"}
NAV_FIELDS = {"section", "featured", "order", "workspaces"}
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


@dataclass(frozen=True)
class Nav:
    """How the extension appears in the host's navigation (Harbor's sidebar). All optional.

    section    key of a section in config/nav.yaml: list the extension under that Harbor module instead of only in the catalog
    featured   ask to be shown directly in the sidebar's Extensions group (the platform caps how many are shown)
    order      sort key within a section / the featured list (lower first)
    workspaces only offer it in these Harbor workspaces; empty = every workspace

    section and featured are promotions: official tier only, and CI routes any change to platform-team review.
    """

    section: str | None = None
    featured: bool = False
    order: int = 100
    workspaces: frozenset[str] = frozenset()


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
    nav: Nav = Nav()


def parse_nav(data: Any, tier: str, err) -> Nav:
    if data is None:
        return Nav()
    if not isinstance(data, dict):
        raise err("nav must be a mapping")
    unknown = sorted(set(data) - NAV_FIELDS)
    if unknown:
        raise err(f"Unknown nav field {', '.join(map(str, unknown))} (allowed: {', '.join(sorted(NAV_FIELDS))})")
    section = data.get("section")
    if section is not None and (not isinstance(section, str) or not SLUG_RE.match(section)):
        raise err("nav.section must be a section key from config/nav.yaml")
    featured = data.get("featured", False)
    if not isinstance(featured, bool):
        raise err("nav.featured must be true or false")
    if (section or featured) and tier != "official":
        raise err("nav.section and nav.featured are only for official-tier extensions")
    order = data.get("order", 100)
    if not isinstance(order, int) or isinstance(order, bool) or not 0 <= order <= 10_000:
        raise err("nav.order must be an integer between 0 and 10000")
    workspaces = data.get("workspaces") or []
    if not isinstance(workspaces, list) or not all(isinstance(w, str) and SLUG_RE.match(w) for w in workspaces):
        raise err("nav.workspaces must be a list of workspace keys")
    return Nav(section=section, featured=featured, order=order, workspaces=frozenset(workspaces))


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
        nav=parse_nav(data.get("nav"), tier, err),
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


@dataclass(frozen=True)
class NavConfig:
    """config/nav.yaml, maintained by the platform team: the Harbor sections extensions may join, and the sidebar cap."""

    sections: dict[str, str]  # key -> title
    max_featured: int = 5


def load_nav_config(path: Path) -> tuple[NavConfig, list[str]]:
    if not path.exists():
        return NavConfig({}), []
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        return NavConfig({}), [f"config/nav.yaml: {e}"]
    errors: list[str] = []
    sections: dict[str, str] = {}
    for key, item in (raw.get("sections") or {}).items():
        if not SLUG_RE.match(str(key)) or not isinstance(item, dict) or not item.get("title"):
            errors.append(f"config/nav.yaml: section {key} needs a key of letters/digits and a title")
            continue
        sections[str(key)] = str(item["title"])
    max_featured = raw.get("max_featured", 5)
    if not isinstance(max_featured, int) or not 0 <= max_featured <= 20:
        errors.append("config/nav.yaml: max_featured must be an integer between 0 and 20")
        max_featured = 5
    return NavConfig(sections, max_featured), errors


def reference_errors(ext: Extension, connectors: dict[str, Connector]) -> list[str]:
    errors = []
    for cap_id in ext.capabilities:
        connector, key = split_capability_id(cap_id)
        if connector not in connectors:
            errors.append(f"Extension {ext.name}: connector {connector} is not registered")
        elif key not in connectors[connector].capabilities:
            errors.append(f"Extension {ext.name}: connector {connector} has no capability {key}")
    return errors
