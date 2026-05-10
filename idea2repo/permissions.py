"""Deny-first permission model for local agent operations."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Operation(str, Enum):
    """Operations that may require explicit user permission."""

    WRITE = "write"
    OVERWRITE = "overwrite"
    NETWORK = "network"
    LOGIN = "login"
    INSTALL = "install"
    PUBLISH = "publish"


class PermissionDeniedError(PermissionError):
    """Raised when an operation is not allowed by the current policy."""


@dataclass(frozen=True)
class PermissionPolicy:
    """Simple deny-first policy inspired by Codex and Claude Code permissions."""

    allow_write: bool = True
    allow_overwrite: bool = False
    allow_network: bool = False
    allow_login: bool = False
    allow_install: bool = False
    allow_publish: bool = False

    def allows(self, operation: Operation) -> bool:
        return {
            Operation.WRITE: self.allow_write,
            Operation.OVERWRITE: self.allow_overwrite,
            Operation.NETWORK: self.allow_network,
            Operation.LOGIN: self.allow_login,
            Operation.INSTALL: self.allow_install,
            Operation.PUBLISH: self.allow_publish,
        }[operation]

    def require(self, operation: Operation, detail: str = "") -> None:
        if self.allows(operation):
            return
        suffix = f": {detail}" if detail else ""
        raise PermissionDeniedError(f"operation requires explicit permission: {operation.value}{suffix}")

    def as_dict(self) -> dict[str, bool]:
        return {
            operation.value: self.allows(operation)
            for operation in Operation
        }


def default_policy(*, allow_overwrite: bool = False) -> PermissionPolicy:
    """Default local policy: writes are allowed, risky side effects are denied."""

    return PermissionPolicy(allow_overwrite=allow_overwrite)
