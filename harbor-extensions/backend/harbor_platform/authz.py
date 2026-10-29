"""Authorization: the gateway is the single decision point.

  allow = capability is open (method+path hits the allow list, data class is open)
       ∩ caller can see this extension (visibility)
       ∩ credential scope includes the capability
       ∩ caller is in an AD group the capability requires
       ∩ extension declares the capability; write capabilities also need a platform-team grant

Every denial carries a readable reason and what is needed to fix it (need), so users can request access and Copilot can self-repair.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .auth import Principal
from .connectors import Capability
from .extensions import Extension


@dataclass(frozen=True)
class Decision:
    allowed: bool
    code: str = "ok"
    reason: str = ""
    need: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {"allowed": self.allowed, "code": self.code, "reason": self.reason, "need": self.need}


ALLOW = Decision(True)


def deny(code: str, reason: str, need: list[str] | None = None) -> Decision:
    return Decision(False, code, reason, need or [])


def check_extension_access(principal: Principal, ext: Extension) -> Decision:
    if not (ext.visibility & principal.groups):
        groups = sorted(ext.visibility)
        return deny("visibility", f"Extension {ext.name} is visible only to members of AD group {' / '.join(groups)}", groups)
    return ALLOW


def authorize(
    principal: Principal,
    ext: Extension | None,
    cap: Capability | None,
    connector: str,
    allowed_data_classes: list[str],
    grants: dict[str, frozenset[str]],
) -> Decision:
    if cap is None:
        return deny("no_capability", f"Connector {connector} does not expose this operation (method and path are not in any capability's allow list)")
    if cap.data_class not in allowed_data_classes:
        return deny("data_class", f"Capability {cap.id} has data class {cap.data_class}, which is not open at this stage")
    if cap.cli_only and principal.kind == "session":
        return deny("cli_only", f"Capability {cap.id} can only be called through the CLI path with an approval gate, not from browser extensions")
    if ext is not None:
        d = check_extension_access(principal, ext)
        if not d.allowed:
            return d
    if "*" not in principal.scopes and cap.id not in principal.scopes:
        return deny("scope", f"Credential scope does not include {cap.id}", [cap.id])
    if not (cap.groups & principal.groups):
        groups = sorted(cap.groups)
        return deny("missing_group", f"You must join AD group {' or '.join(groups)} to use {cap.id}", groups)
    if ext is not None:
        if cap.id not in ext.capabilities:
            return deny("not_declared", f"Extension {ext.name} has not declared capability {cap.id} in extension.yaml", [cap.id])
        if cap.write and cap.id not in grants.get(ext.name, frozenset()):
            return deny(
                "not_granted",
                f"Write capability {cap.id} has not been granted to extension {ext.name} (needs platform-team approval, recorded in config/grants.yaml)",
                [cap.id],
            )
    return ALLOW
