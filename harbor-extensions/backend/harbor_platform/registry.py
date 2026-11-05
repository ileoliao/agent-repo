"""Read connectors, extensions and grants from the content directory.

The directory is mounted from object storage in production. Reload when files change.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Generic, TypeVar

from .config import Settings
from .connectors import Capability, Connector, load_connectors, split_capability_id
from .extensions import Extension, NavConfig, load_extensions, load_grants, load_nav_config, reference_errors

T = TypeVar("T")


def _signature(paths: Iterable[Path]) -> tuple[Any, ...]:
    out = []
    for p in paths:
        try:
            st = p.stat()
        except FileNotFoundError:
            continue
        out.append((str(p), st.st_mtime_ns, st.st_size))
    return tuple(out)


class _Snapshot(Generic[T]):
    def __init__(self, signature: Callable[[], tuple[Any, ...]], load: Callable[[], T]) -> None:
        self._signature = signature
        self._load = load
        self._sig: tuple[Any, ...] | None = None
        self._value: T | None = None
        self._lock = threading.Lock()

    def get(self) -> T:
        with self._lock:
            sig = self._signature()
            if sig != self._sig or self._value is None:
                self._value = self._load()
                self._sig = sig
            return self._value


class Registry:
    def __init__(self, settings: Settings) -> None:
        s = settings
        self._connectors = _Snapshot(
            lambda: _signature(sorted(s.connectors_dir.glob("*.yaml"))),
            lambda: load_connectors(s.connectors_dir, s.mock_base),
        )
        self._extensions = _Snapshot(
            lambda: _signature(sorted(s.extensions_dir.glob("*/extension.yaml"))),
            lambda: load_extensions(s.extensions_dir),
        )
        self._grants = _Snapshot(lambda: _signature([s.grants_file]), lambda: load_grants(s.grants_file))
        self._nav = _Snapshot(lambda: _signature([s.nav_file]), lambda: load_nav_config(s.nav_file))

    @property
    def connectors(self) -> dict[str, Connector]:
        return self._connectors.get()[0]

    @property
    def extensions(self) -> dict[str, Extension]:
        return self._extensions.get()[0]

    @property
    def grants(self) -> dict[str, frozenset[str]]:
        return self._grants.get()[0]

    @property
    def nav(self) -> NavConfig:
        return self._nav.get()[0]

    @property
    def errors(self) -> list[str]:
        connectors, connector_errors = self._connectors.get()
        extensions, extension_errors = self._extensions.get()
        _, grant_errors = self._grants.get()
        nav, nav_errors = self._nav.get()
        references = [error for ext in extensions.values() for error in reference_errors(ext, connectors)]
        references += [f"Extension {ext.name}: nav.section {ext.nav.section} is not defined" for ext in extensions.values() if ext.nav.section and ext.nav.section not in nav.sections]
        return connector_errors + extension_errors + grant_errors + nav_errors + references

    def capability(self, cap_id: str) -> Capability | None:
        connector, key = split_capability_id(cap_id)
        c = self.connectors.get(connector)
        return c.capabilities.get(key) if c else None
