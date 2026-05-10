"""Manifest, run log, status, validation, and resume support."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATE_DIR = Path(".idea2repo")
MANIFEST_PATH = STATE_DIR / "manifest.json"
RUN_LOG_PATH = STATE_DIR / "run_log.jsonl"


@dataclass(frozen=True)
class ProjectStatus:
    """Current state derived from a generated repository manifest."""

    root: Path
    project_name: str
    stage: str
    total_artifacts: int
    present_artifacts: int
    missing_artifacts: tuple[str, ...]
    modified_artifacts: tuple[str, ...]


def artifact_record(root: Path, path: Path) -> dict[str, Any]:
    relative = path.relative_to(root).as_posix()
    content = path.read_bytes()
    return {
        "path": relative,
        "sha256": hashlib.sha256(content).hexdigest(),
        "bytes": len(content),
    }


def write_manifest(
    root: Path,
    *,
    project_name: str,
    idea: str,
    requested_domains: list[str] | None,
    timeline_weeks: int,
    resources: list[str],
    stack: str,
    created_at: str,
    files: list[Path],
    permissions: dict[str, bool],
    workspace: dict[str, object],
    generation: dict[str, object] | None = None,
) -> Path:
    state_dir = root / STATE_DIR
    state_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "version": 1,
        "project_name": project_name,
        "stage": "idea_diagnosis",
        "created_at": created_at,
        "updated_at": _now(),
        "request": {
            "idea": idea,
            "requested_domains": requested_domains or [],
            "timeline_weeks": timeline_weeks,
            "resources": resources,
            "stack": stack,
        },
        "permissions": permissions,
        "workspace": workspace,
        "generation": generation or {},
        "artifacts": [
            artifact_record(root, file_path)
            for file_path in sorted(files)
            if file_path.exists() and not _is_state_file(root, file_path)
        ],
    }
    manifest_path = root / MANIFEST_PATH
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    append_run_log(root, "manifest_written", {"artifacts": len(manifest["artifacts"])})
    return manifest_path


def append_run_log(root: Path, event: str, data: dict[str, Any] | None = None) -> None:
    state_dir = root / STATE_DIR
    state_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "timestamp": _now(),
        "event": event,
        "data": data or {},
    }
    with (root / RUN_LOG_PATH).open("a", encoding="utf-8", newline="\n") as log_file:
        log_file.write(json.dumps(payload, sort_keys=True) + "\n")


def read_manifest(root: str | Path) -> dict[str, Any]:
    manifest_path = Path(root) / MANIFEST_PATH
    if not manifest_path.exists():
        raise FileNotFoundError(f"missing Idea2Repo manifest: {manifest_path}")
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def status(root: str | Path) -> ProjectStatus:
    project_root = Path(root)
    manifest = read_manifest(project_root)
    missing: list[str] = []
    modified: list[str] = []
    for artifact in manifest.get("artifacts", []):
        path = project_root / artifact["path"]
        if not path.exists():
            missing.append(artifact["path"])
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != artifact.get("sha256"):
            modified.append(artifact["path"])
    total = len(manifest.get("artifacts", []))
    return ProjectStatus(
        root=project_root,
        project_name=manifest.get("project_name", project_root.name),
        stage=manifest.get("stage", "unknown"),
        total_artifacts=total,
        present_artifacts=total - len(missing),
        missing_artifacts=tuple(missing),
        modified_artifacts=tuple(modified),
    )


def validate(root: str | Path) -> tuple[str, ...]:
    current = status(root)
    errors: list[str] = []
    errors.extend(f"missing artifact: {path}" for path in current.missing_artifacts)
    errors.extend(f"modified artifact: {path}" for path in current.modified_artifacts)
    return tuple(errors)


def _is_state_file(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root / STATE_DIR)
    except ValueError:
        return False
    return True


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
