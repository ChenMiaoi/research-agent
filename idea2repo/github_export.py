"""Safe GitHub export planning and optional publish helpers."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol, Sequence

from .permissions import Operation, PermissionPolicy, default_policy
from .providers import contains_secret_material


class CommandRunner(Protocol):
    """Minimal runner interface for publishing commands."""

    def __call__(self, command: Sequence[str], *, cwd: Path) -> None:
        ...


@dataclass(frozen=True)
class GithubIssue:
    """A sanitized issue payload for GitHub export."""

    title: str
    body: str
    labels: tuple[str, ...]

    def public_dict(self) -> dict[str, object]:
        return {
            "title": self.title,
            "body": self.body,
            "labels": list(self.labels),
        }


@dataclass(frozen=True)
class GithubExportPlan:
    """Dry-run-first GitHub export plan."""

    root: Path
    repo_name: str
    issues: tuple[GithubIssue, ...]
    pull_request: dict[str, str]
    publish_performed: bool = False

    def public_dict(self) -> dict[str, object]:
        return {
            "dry_run": not self.publish_performed,
            "repo_name": self.repo_name,
            "source": str(self.root),
            "issues": [issue.public_dict() for issue in self.issues],
            "would_create_issues": len(self.issues),
            "pull_request": self.pull_request,
            "publish_performed": self.publish_performed,
        }

    def json(self) -> str:
        return json.dumps(self.public_dict(), indent=2, sort_keys=True) + "\n"


def build_github_export_plan(
    output: str | Path,
    *,
    repo_name: str = "",
    create_issues: bool = True,
) -> GithubExportPlan:
    """Build a dry-run export plan from generated repo artifacts."""

    root = Path(output).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"output not found: {root}")
    resolved_repo_name = _safe_repo_name(repo_name or root.name)
    issues = tuple(_issue_payloads(root)) if create_issues else ()
    _reject_secret_payloads(issues)
    return GithubExportPlan(
        root=root,
        repo_name=resolved_repo_name,
        issues=issues,
        pull_request={
            "title": "Draft: Idea2Repo research scaffold",
            "body": (
                "Generated from local Idea2Repo artifacts. Validate evidence, "
                "security scope, and provider settings before publishing."
            ),
            "base": "main",
            "draft": "true",
        },
    )


def publish_with_gh(
    plan: GithubExportPlan,
    *,
    permission_policy: PermissionPolicy | None = None,
    runner: CommandRunner | None = None,
) -> GithubExportPlan:
    """Publish an export plan with `gh` after explicit publish permission."""

    policy = permission_policy or default_policy()
    policy.require(Operation.PUBLISH, "GitHub export")
    _reject_secret_payloads(plan.issues)
    publish_files = _scanned_publish_files(plan.root)
    runner = runner or _run_command
    with tempfile.TemporaryDirectory(prefix="idea2repo-github-") as tmp:
        publish_root = Path(tmp) / plan.root.name
        copied_files = _copy_publish_tree(plan.root, publish_root, publish_files)
        _prepare_git_repository(publish_root, copied_files, runner)
        runner(
            [
                "gh",
                "repo",
                "create",
                plan.repo_name,
                "--private",
                "--source",
                str(publish_root),
                "--remote",
                "origin",
                "--push",
            ],
            cwd=publish_root,
        )
        for issue in plan.issues:
            command = [
                "gh",
                "issue",
                "create",
                "--title",
                issue.title,
                "--body",
                issue.body,
            ]
            if issue.labels:
                command.extend(["--label", ",".join(issue.labels)])
            runner(command, cwd=publish_root)
    return GithubExportPlan(
        root=plan.root,
        repo_name=plan.repo_name,
        issues=plan.issues,
        pull_request=plan.pull_request,
        publish_performed=True,
    )


def _issue_payloads(root: Path) -> list[GithubIssue]:
    issues: list[GithubIssue] = []
    todo_path = root / "docs/execution_plan/todo.md"
    if todo_path.exists():
        for line in todo_path.read_text(encoding="utf-8").splitlines():
            item = line.removeprefix("- ").strip()
            if item and line.startswith("- "):
                issues.append(
                    GithubIssue(
                        title=_truncate_title(f"Research task: {item}"),
                        body=f"Source: `docs/execution_plan/todo.md`\n\n{item}",
                        labels=("research", "todo"),
                    )
                )
    milestone_path = root / "docs/execution_plan/milestones.md"
    if milestone_path.exists():
        for line in milestone_path.read_text(encoding="utf-8").splitlines():
            if not line.startswith("| M"):
                continue
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if cells and cells[0].casefold() == "milestone":
                continue
            if len(cells) >= 3:
                issues.append(
                    GithubIssue(
                        title=_truncate_title(f"Milestone: {cells[0]} {cells[1]}"),
                        body=(
                            "Source: `docs/execution_plan/milestones.md`\n\n"
                            f"Exit criteria: {cells[1]}"
                        ),
                        labels=("research", "milestone"),
                    )
                )
    return issues


def _reject_secret_payloads(issues: tuple[GithubIssue, ...]) -> None:
    for issue in issues:
        payload = json.dumps(asdict(issue), sort_keys=True)
        if contains_secret_material(payload):
            raise ValueError("refusing to export issue with secret-like material")


def _scanned_publish_files(root: Path) -> list[Path]:
    publish_files: list[Path] = []
    for path in _candidate_publish_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if contains_secret_material(text):
            relative = path.relative_to(root).as_posix()
            raise ValueError(f"refusing to publish secret-like material in {relative}")
        publish_files.append(path)
    return publish_files


def _candidate_publish_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            continue
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if _is_publish_ignored(relative):
            continue
        files.append(path)
    return files


def _is_publish_ignored(relative_path: str) -> bool:
    parts = relative_path.split("/")
    lowered_parts = [part.casefold() for part in parts]
    ignored_dirs = {
        ".git",
        ".idea2repo",
        ".venv",
        "venv",
        "node_modules",
        "dist",
        ".vite",
        ".turbo",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "__pycache__",
    }
    root_ignored_dirs = {
        "artifacts",
        "runs",
        "outputs",
        "datasets",
        "pdfs",
        "checkpoints",
        "models",
        "wandb",
        "mlruns",
    }
    if any(part in ignored_dirs for part in lowered_parts):
        return True
    if lowered_parts and lowered_parts[0] in root_ignored_dirs:
        return True
    if lowered_parts[:2] == [".aws", "credentials"]:
        return True
    if lowered_parts[:2] == [".config", "gh"]:
        return True
    if len(lowered_parts) >= 2 and lowered_parts[0] == "data" and lowered_parts[1] in {"raw", "processed"}:
        return True
    if len(lowered_parts) >= 2 and lowered_parts[0] == "results" and lowered_parts[1] in {
        "logs",
        "tables",
        "figures",
    }:
        return True
    if (
        lowered_parts[:3] == ["docs", "reference", "pdfs"]
        and "/".join(lowered_parts) != "docs/reference/pdfs/readme.md"
    ):
        return True
    name = parts[-1]
    lowered_name = name.casefold()
    ignored_names = {
        ".DS_Store",
        "Thumbs.db",
        ".env",
        ".env.local",
        ".env.development",
        ".env.production",
        ".env.test",
        "credentials.json",
        "token.json",
        "cookies.txt",
        "secrets.json",
        ".netrc",
        "_netrc",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    }
    if lowered_name in {ignored.casefold() for ignored in ignored_names}:
        return True
    if lowered_name.startswith(".env.") and lowered_name != ".env.example":
        return True
    sensitive_name_tokens = ("credential", "credentials", "token", "secret")
    if any(token in lowered_name for token in sensitive_name_tokens):
        return True
    ignored_suffixes = (
        ".pem",
        ".key",
        ".crt",
        ".p12",
        ".pfx",
        ".jks",
        ".keystore",
        ".sqlite",
        ".sqlite3",
        ".db",
        ".pid",
        ".ckpt",
        ".pt",
        ".pth",
        ".safetensors",
        ".onnx",
        ".gguf",
        ".parquet",
        ".feather",
        ".arrow",
        ".zip",
        ".tar",
        ".tar.gz",
        ".7z",
    )
    return any(lowered_name.endswith(suffix) for suffix in ignored_suffixes)


def _copy_publish_tree(root: Path, publish_root: Path, publish_files: Sequence[Path]) -> list[Path]:
    copied_files: list[Path] = []
    publish_root.mkdir(parents=True, exist_ok=True)
    for source_path in publish_files:
        relative = source_path.relative_to(root)
        destination = publish_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
        copied_files.append(destination)
    return copied_files


def _prepare_git_repository(
    root: Path,
    publish_files: Sequence[Path],
    runner: CommandRunner,
) -> None:
    runner(["git", "init"], cwd=root)
    for batch in _path_batches(root, publish_files, size=80):
        runner(["git", "add", "--", *batch], cwd=root)
    runner(
        [
            "git",
            "-c",
            "user.name=Idea2Repo",
            "-c",
            "user.email=idea2repo@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "chore: initialize Idea2Repo scaffold",
        ],
        cwd=root,
    )


def _path_batches(root: Path, files: Sequence[Path], *, size: int) -> list[list[str]]:
    relative_paths = [path.relative_to(root).as_posix() for path in files]
    return [
        relative_paths[index:index + size]
        for index in range(0, len(relative_paths), size)
    ]


def _safe_repo_name(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in {"-", "_", "."} else "-" for char in value)
    cleaned = cleaned.strip(".-_")
    return cleaned[:100] or "idea2repo-project"


def _truncate_title(value: str) -> str:
    return value[:97] + "..." if len(value) > 100 else value


def _run_command(command: Sequence[str], *, cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)
