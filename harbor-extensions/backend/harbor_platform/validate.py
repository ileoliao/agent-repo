"""CI validation: runs on PRs and decides whether a change can be auto-merged.

  python -m harbor_platform.validate [--root REPO] [--base MAIN_CHECKOUT] [--ignore-base-errors] [--json]

Exit codes: 0 = valid and auto-mergeable; 1 = errors; 2 = valid but needs platform-team review.

--ignore-base-errors (content publishing): errors already present in --base are reported but do not block, so one
extension that is already live with an error cannot stop every other extension or policy from publishing.

Errors: invalid config, references to nonexistent capabilities, extension code violating rules (see lint.py: custom login, own network requests, etc.).

Cases that need manual review (everything else auto-merges):
  * extension code uses HTML injection APIs such as innerHTML;
  * extension requests a write capability that has not been granted;
  * extension requests a capability above the internal data class;
  * extension visibility is wider than on main;
  * extension asks for a navigation promotion (nav.section / nav.featured), or changes one;
  * config/grants.yaml, config/nav.yaml or connectors/ itself changed (only the platform team may modify them).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .config import REPO_ROOT
from .connectors import load_connectors, split_capability_id
from .extensions import load_extensions, load_grants, load_nav_config, reference_errors
from .lint import lint_extension


def _file_text(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.exists() else None


def validate(root: Path, base: Path | None = None, ignore_base_errors: bool = False) -> dict[str, Any]:
    connectors, errors = load_connectors(root / "connectors", "http://mock")
    extensions, ext_errors = load_extensions(root / "extensions")
    grants, grant_errors = load_grants(root / "config" / "grants.yaml")
    nav, nav_errors = load_nav_config(root / "config" / "nav.yaml")
    errors = errors + ext_errors + grant_errors + nav_errors

    lint_review: dict[str, list[str]] = {}
    for ext in extensions.values():
        errors += reference_errors(ext, connectors)
        if ext.nav.section and ext.nav.section not in nav.sections:
            errors.append(f"Extension {ext.name}: nav.section {ext.nav.section} is not defined in config/nav.yaml")
        linted = lint_extension(ext.path)
        errors += linted.errors
        lint_review[ext.name] = linted.review
    for ext_name, caps in grants.items():
        if ext_name not in extensions:
            errors.append(f"config/grants.yaml: extension {ext_name} does not exist")
            continue
        for cap_id in caps:
            if cap_id not in extensions[ext_name].capabilities:
                errors.append(f"config/grants.yaml: extension {ext_name} has not declared capability {cap_id}")

    base_exts = load_extensions(base / "extensions")[0] if base else {}
    review: dict[str, list[str]] = {}
    for ext in extensions.values():
        reasons = list(lint_review[ext.name])
        for cap_id in ext.capabilities:
            connector, key = split_capability_id(cap_id)
            cap = connectors.get(connector, None)
            cap = cap.capabilities.get(key) if cap else None
            if cap is None:
                continue
            if cap.write and cap_id not in grants.get(ext.name, frozenset()):
                reasons.append(f"requests write capability {cap_id} (grant must be recorded in config/grants.yaml)")
            if cap.data_class != "internal":
                reasons.append(f"capability {cap_id} has data class {cap.data_class}")
        if base is not None:
            # Like visibility, promotions are judged against main: CI passes --base
            old = base_exts.get(ext.name)
            old_promo = (old.nav.section, old.nav.featured) if old else (None, False)
            if (ext.nav.section, ext.nav.featured) != old_promo and (ext.nav.section or ext.nav.featured):
                reasons.append(f"navigation promotion: section={ext.nav.section or '-'}, featured={ext.nav.featured}")
            if old is not None and not ext.visibility <= old.visibility:
                added = sorted(ext.visibility - old.visibility)
                reasons.append(f"visibility widened: added {', '.join(added)}")
        if reasons:
            review[ext.name] = reasons

    platform_changes = []
    if base is not None:
        connector_files = {p.name for d in (root, base) for p in (d / "connectors").glob("*.yaml")}
        for path in ["config/grants.yaml", "config/nav.yaml", *(f"connectors/{n}" for n in sorted(connector_files))]:
            if _file_text(root / path) != _file_text(base / path):
                platform_changes.append(path)

    preexisting: list[str] = []
    if ignore_base_errors and base is not None:
        known = set(validate(base)["errors"])
        preexisting = [e for e in errors if e in known]
        errors = [e for e in errors if e not in known]

    return {
        "errors": errors,
        "preexisting_errors": preexisting,
        "review": review,
        "platform_changes": platform_changes,
        "extensions": sorted(extensions),
        "connectors": sorted(connectors),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=REPO_ROOT)
    ap.add_argument("--base", type=Path, default=None, help="main-branch checkout directory, used to compare visibility and platform file changes")
    ap.add_argument("--ignore-base-errors", action="store_true", help="do not block on errors that --base already has")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    report = validate(args.root, args.base, args.ignore_base_errors)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Connectors: {', '.join(report['connectors']) or 'none'}")
        print(f"Extensions: {', '.join(report['extensions']) or 'none'}")
        for e in report["errors"]:
            print(f"  ✗ {e}")
        for e in report["preexisting_errors"]:
            print(f"  ! already in base, not blocking: {e}")
        for name, reasons in report["review"].items():
            for r in reasons:
                print(f"  ⚑ {name}: {r}")
        for p in report["platform_changes"]:
            print(f"  ⚑ Platform file changed: {p}")

    if report["errors"]:
        print("Result: validation failed")
        return 1
    if report["review"] or report["platform_changes"]:
        print("Result: platform-team review required")
        return 2
    print("Result: can be auto-merged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
