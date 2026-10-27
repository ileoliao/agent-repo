"""Connector definitions: how an internal system is reached, and its operations grouped by capability.

A capability is a stable contract for extensions: id = <connector>.<capability>, e.g. snow.change.write.
Each capability consists of allow rules (METHOD /path; * matches one segment, ** matches several),
the required AD groups, a data class, and whether it is a write operation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,40}$")
CAP_KEY_RE = re.compile(r"^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$")
DATA_CLASSES = ("internal", "confidential", "customer")
AUTH_TYPES = ("service-account", "identity-only")


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Rule:
    method: str
    pattern: str
    regex: re.Pattern[str]

    def matches(self, method: str, path: str) -> bool:
        return self.method == method and self.regex.fullmatch(path) is not None


def compile_rule(text: Any) -> Rule:
    parts = str(text).split()
    if len(parts) != 2:
        raise ConfigError(f"allow rule must be in the form 'METHOD /path': {text!r}")
    method, pattern = parts[0].upper(), parts[1]
    if method not in METHODS:
        raise ConfigError(f"Unsupported method {method} (allowed: {', '.join(METHODS)})")
    if not pattern.startswith("/") or ".." in pattern.split("/"):
        raise ConfigError(f"Path must start with / and must not contain ..: {pattern}")
    rx = re.escape(pattern).replace(r"\*\*", "\0").replace(r"\*", "[^/]+").replace("\0", ".*")
    return Rule(method, pattern, re.compile(rx))


@dataclass(frozen=True)
class Capability:
    id: str
    connector: str
    key: str
    description: str
    rules: tuple[Rule, ...]
    groups: frozenset[str]
    data_class: str
    write: bool
    cli_only: bool

    def matches(self, method: str, path: str) -> bool:
        return any(r.matches(method, path) for r in self.rules)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "connector": self.connector,
            "description": self.description,
            "allow": [f"{r.method} {r.pattern}" for r in self.rules],
            "groups": sorted(self.groups),
            "data_class": self.data_class,
            "write": self.write,
            "cli_only": self.cli_only,
        }


@dataclass(frozen=True)
class Connector:
    name: str
    title: str
    description: str
    owner: str
    upstream: str
    auth_type: str
    auth_secret: str | None
    capabilities: dict[str, Capability]

    def match(self, method: str, path: str) -> Capability | None:
        for cap in self.capabilities.values():
            if cap.matches(method, path):
                return cap
        return None


def parse_connector(data: Any, source: str, mock_base: str) -> Connector:
    def err(msg: str) -> ConfigError:
        return ConfigError(f"{source}: {msg}")

    if not isinstance(data, dict):
        raise err("top level must be a mapping")
    name = data.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise err("name must be lowercase letters, digits and hyphens")
    if Path(source).stem != name:
        raise err(f"File name must match name (expected {name}.yaml)")
    owner = data.get("owner")
    if not owner:
        raise err("Missing owner")
    upstream = data.get("upstream")
    if not isinstance(upstream, str):
        raise err("Missing upstream")
    upstream = upstream.replace("${MOCK_BASE}", mock_base)
    if not upstream.startswith(("http://", "https://")):
        raise err("upstream must be an http(s) URL")

    auth = data.get("auth") or {}
    auth_type = auth.get("type", "service-account")
    if auth_type not in AUTH_TYPES:
        raise err(f"auth.type must be one of {AUTH_TYPES}")
    secret = auth.get("secret")
    if auth_type == "service-account" and not secret:
        raise err("service-account auth requires auth.secret (the credential name, not the credential itself)")

    raw_caps = data.get("capabilities")
    if not isinstance(raw_caps, dict) or not raw_caps:
        raise err("At least one capability is required")

    caps: dict[str, Capability] = {}
    for key, c in raw_caps.items():
        if not isinstance(key, str) or not CAP_KEY_RE.match(key):
            raise err(f"Invalid capability name {key!r}")
        if not isinstance(c, dict):
            raise err(f"Capability {key} must be a mapping")
        allow = c.get("allow")
        if not isinstance(allow, list) or not allow:
            raise err(f"Capability {key} is missing an allow list")
        try:
            rules = tuple(compile_rule(r) for r in allow)
        except ConfigError as e:
            raise err(f"Capability {key}: {e}") from e
        groups = c.get("groups")
        if not isinstance(groups, list) or not groups:
            raise err(f"Capability {key} must be bound to at least one AD group")
        data_class = c.get("data_class", "internal")
        if data_class not in DATA_CLASSES:
            raise err(f"Capability {key}: data_class must be one of {DATA_CLASSES}")
        has_write_method = any(r.method != "GET" for r in rules)
        write = bool(c.get("write", False))
        if has_write_method and not write:
            raise err(f"Capability {key} includes write methods and must be marked write: true")
        caps[key] = Capability(
            id=f"{name}.{key}",
            connector=name,
            key=key,
            description=str(c.get("description", "")),
            rules=rules,
            groups=frozenset(str(g) for g in groups),
            data_class=data_class,
            write=write,
            cli_only=bool(c.get("cli_only", False)),
        )

    return Connector(
        name=name,
        title=str(data.get("title", name)),
        description=str(data.get("description", "")),
        owner=str(owner),
        upstream=upstream,
        auth_type=auth_type,
        auth_secret=secret,
        capabilities=caps,
    )


def load_connectors(directory: Path, mock_base: str) -> tuple[dict[str, Connector], list[str]]:
    connectors: dict[str, Connector] = {}
    errors: list[str] = []
    for path in sorted(directory.glob("*.yaml")):
        try:
            c = parse_connector(yaml.safe_load(path.read_text(encoding="utf-8")), path.name, mock_base)
            connectors[c.name] = c
        except (ConfigError, yaml.YAMLError) as e:
            errors.append(str(e))
    return connectors, errors


def split_capability_id(cap_id: str) -> tuple[str, str]:
    connector, _, key = cap_id.partition(".")
    return connector, key
