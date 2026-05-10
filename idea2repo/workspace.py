"""Workspace inspection helpers for project-aware runs."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WorkspaceSnapshot:
    """Small, serializable view of the workspace that launched generation."""

    cwd: str
    git_root: str | None
    git_branch: str | None
    git_status_short: tuple[str, ...]
    tracked_files: int | None

    def as_dict(self) -> dict[str, object]:
        return {
            "cwd": self.cwd,
            "git_root": self.git_root,
            "git_branch": self.git_branch,
            "git_status_short": list(self.git_status_short),
            "tracked_files": self.tracked_files,
        }


def inspect_workspace(cwd: str | Path | None = None) -> WorkspaceSnapshot:
    """Inspect local Git context without mutating the repository."""

    root = Path(cwd or Path.cwd()).resolve()
    git_root = _git(root, "rev-parse", "--show-toplevel")
    git_branch = _git(root, "branch", "--show-current") if git_root else None
    status = _git(root, "status", "--short") if git_root else None
    tracked = _git(root, "ls-files") if git_root else None
    return WorkspaceSnapshot(
        cwd=str(root),
        git_root=git_root.strip() if git_root else None,
        git_branch=git_branch.strip() if git_branch else None,
        git_status_short=tuple(line for line in (status or "").splitlines() if line),
        tracked_files=len([line for line in (tracked or "").splitlines() if line]) if tracked is not None else None,
    )


def _git(cwd: Path, *args: str) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return completed.stdout
