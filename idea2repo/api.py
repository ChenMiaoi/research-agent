"""FastAPI backend for Idea2Repo.

The API is intentionally local-first: write operations target an explicit output
directory, network literature search is off unless requested, and publish-like
operations expose dry-run payloads only.
"""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .generator import generate_research_repo, resume_research_repo
from .literature import search_literature
from .providers import safe_provider_report, validate_provider_config
from .scoring import diagnose_idea
from .state import status as project_status
from .state import validate as validate_project
from .workflow import run_workflow


class GenerateRequest(BaseModel):
    idea: str
    output: str
    domains: list[str] = Field(default_factory=list)
    weeks: int = 12
    resources: list[str] = Field(default_factory=list)
    stack: str = "python"
    force: bool = False


class PathRequest(BaseModel):
    output: str


class ResumeRequest(BaseModel):
    output: str
    force: bool = False


class ArtifactReadRequest(BaseModel):
    output: str
    path: str


class LiteratureRequest(BaseModel):
    query: str
    allow_network: bool = False
    limit: int = 10


class ScoreRequest(BaseModel):
    idea: str
    domains: list[str] = Field(default_factory=list)


class RebuttalRequest(BaseModel):
    reviews: list[str] = Field(default_factory=list)
    idea: str = ""
    domains: list[str] = Field(default_factory=list)


class GithubDryRunRequest(BaseModel):
    output: str
    repo_name: str = ""
    create_issues: bool = True


def create_app() -> FastAPI:
    app = FastAPI(title="Idea2Repo API", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "service": "idea2repo"}

    @app.post("/generate")
    def generate(request: GenerateRequest) -> dict[str, object]:
        try:
            result = generate_research_repo(
                request.idea,
                request.output,
                requested_domains=request.domains,
                timeline_weeks=request.weeks,
                resources=request.resources,
                stack=request.stack,
                force=request.force,
            )
        except (FileExistsError, PermissionError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "root": str(result.root),
            "project_name": result.project_name,
            "primary_route": result.diagnosis.routes[0].domain.key,
            "raw_score": result.diagnosis.raw_score.total,
            "revised_score": result.diagnosis.revised_score.total,
            "evidence_gate": _evidence_payload(result.diagnosis.evidence_gate),
            "security": _security_payload(result.diagnosis.security_assessment),
        }

    @app.post("/status")
    def status(request: PathRequest) -> dict[str, object]:
        try:
            current = project_status(request.output)
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {
            "project_name": current.project_name,
            "stage": current.stage,
            "total_artifacts": current.total_artifacts,
            "present_artifacts": current.present_artifacts,
            "missing_artifacts": list(current.missing_artifacts),
            "modified_artifacts": list(current.modified_artifacts),
        }

    @app.post("/resume")
    def resume(request: ResumeRequest) -> dict[str, object]:
        try:
            result = resume_research_repo(request.output, force=request.force)
        except (FileNotFoundError, PermissionError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "root": str(result.root),
            "restored_files": [
                path.relative_to(result.root).as_posix()
                if _is_relative_to(path.resolve(), result.root.resolve())
                else str(path)
                for path in result.files
            ],
        }

    @app.post("/validate")
    def validate(request: PathRequest) -> dict[str, object]:
        try:
            errors = validate_project(request.output)
        except Exception as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"ok": not errors, "errors": list(errors)}

    @app.post("/artifacts")
    def artifacts(request: PathRequest) -> dict[str, object]:
        root = _existing_root(request.output)
        entries = _artifact_entries(root)
        return {
            "root": str(root),
            "artifacts": entries,
            "tree": _artifact_tree(entries),
        }

    @app.post("/artifacts/read")
    def read_artifact(request: ArtifactReadRequest) -> dict[str, object]:
        root = _existing_root(request.output)
        path = _safe_child(root, request.path)
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=404, detail="artifact not found")
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(status_code=415, detail="artifact is not UTF-8 text") from exc
        return {
            "path": path.relative_to(root).as_posix(),
            "bytes": path.stat().st_size,
            "content": content,
        }

    @app.post("/literature/search")
    def literature(request: LiteratureRequest) -> dict[str, object]:
        records, tasks = search_literature(
            request.query,
            allow_network=request.allow_network,
            limit=request.limit,
        )
        return {
            "records": [_paper_payload(record) for record in records],
            "tasks": tasks,
        }

    @app.post("/score")
    def score(request: ScoreRequest) -> dict[str, object]:
        diagnosis = diagnose_idea(request.idea, requested_domains=request.domains)
        return {
            "primary_route": diagnosis.routes[0].domain.key,
            "raw_score": diagnosis.raw_score.total,
            "revised_score": diagnosis.revised_score.total,
            "evidence_gate": _evidence_payload(diagnosis.evidence_gate),
            "security": _security_payload(diagnosis.security_assessment),
            "required_evidence": list(diagnosis.required_evidence),
        }

    @app.post("/reviewer/simulate")
    def reviewer(request: ScoreRequest) -> dict[str, object]:
        diagnosis = diagnose_idea(request.idea, requested_domains=request.domains)
        artifacts = run_workflow(diagnosis)
        return {
            "artifact": "docs/workflow/reviewer_simulation.md",
            "content": artifacts["docs/workflow/reviewer_simulation.md"],
        }

    @app.post("/reviewer")
    def reviewer_legacy(request: ScoreRequest) -> dict[str, object]:
        return reviewer(request)

    @app.post("/rebuttal")
    def rebuttal(request: RebuttalRequest) -> dict[str, object]:
        idea = request.idea or "local research idea"
        diagnosis = diagnose_idea(idea, requested_domains=request.domains)
        artifacts = run_workflow(diagnosis)
        review_count = len([review for review in request.reviews if review.strip()])
        return {
            "artifact": "docs/workflow/rebuttal_plan.md",
            "review_count": review_count,
            "content": artifacts["docs/workflow/rebuttal_plan.md"],
            "clusters": _review_clusters(request.reviews),
        }

    @app.get("/provider")
    def provider() -> dict[str, object]:
        errors = validate_provider_config()
        return {
            "ok": not errors,
            "errors": list(errors),
            "report": safe_provider_report(),
        }

    @app.get("/provider/settings")
    def provider_settings() -> dict[str, object]:
        return provider()

    @app.post("/github/dry-run")
    def github_dry_run(request: GithubDryRunRequest) -> dict[str, object]:
        root = _existing_root(request.output)
        issues = _github_issue_payloads(root) if request.create_issues else []
        return {
            "dry_run": True,
            "repo_name": request.repo_name or root.name,
            "source": str(root),
            "issues": issues,
            "would_create_issues": len(issues),
            "publish_performed": False,
        }

    return app


app = create_app()


def _existing_root(output: str) -> Path:
    root = Path(output).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=404, detail="output not found")
    return root


def _safe_child(root: Path, relative_path: str) -> Path:
    path = (root / relative_path).resolve()
    if not _is_relative_to(path, root):
        raise HTTPException(status_code=400, detail="path escapes output root")
    return path


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _artifact_entries(root: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        entries.append(
            {
                "path": relative,
                "bytes": path.stat().st_size,
                "text": _looks_text(path),
            }
        )
    return entries


def _artifact_tree(entries: list[dict[str, object]]) -> dict[str, Any]:
    tree: dict[str, Any] = {}
    for entry in entries:
        parts = str(entry["path"]).split("/")
        cursor = tree
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {})
        cursor[parts[-1]] = {
            "bytes": entry["bytes"],
            "text": entry["text"],
        }
    return tree


def _looks_text(path: Path) -> bool:
    try:
        path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False
    return True


def _paper_payload(record: object) -> dict[str, object]:
    payload = asdict(record)  # type: ignore[arg-type]
    if isinstance(payload.get("authors"), tuple):
        payload["authors"] = list(payload["authors"])
    return payload


def _evidence_payload(evidence_gate: object) -> dict[str, object]:
    return {
        "submission_ready": getattr(evidence_gate, "submission_ready"),
        "status": "ready" if getattr(evidence_gate, "submission_ready") else "blocked",
        "blocking_reasons": list(getattr(evidence_gate, "blocking_reasons")),
    }


def _security_payload(assessment: object) -> dict[str, object]:
    return {
        "security_relevant": getattr(assessment, "security_relevant"),
        "allowed": getattr(assessment, "allowed"),
        "scope": getattr(assessment, "scope"),
        "reasons": list(getattr(assessment, "reasons")),
        "required_boundaries": list(getattr(assessment, "required_boundaries")),
    }


def _review_clusters(reviews: list[str]) -> list[dict[str, str]]:
    categories = {
        "novelty": ("novel", "related work", "incremental"),
        "soundness": ("sound", "valid", "baseline", "experiment"),
        "significance": ("significant", "impact", "motivation"),
        "reproducibility": ("reproduc", "artifact", "code", "data"),
        "ethics": ("ethic", "security", "privacy", "abuse"),
    }
    clusters: list[dict[str, str]] = []
    for category, needles in categories.items():
        count = sum(
            1 for review in reviews
            if any(needle in review.casefold() for needle in needles)
        )
        if count:
            clusters.append({"category": category, "mentions": str(count)})
    return clusters


def _github_issue_payloads(root: Path) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    todo_path = root / "docs/execution_plan/todo.md"
    if todo_path.exists():
        for line in todo_path.read_text(encoding="utf-8").splitlines():
            item = line.removeprefix("- ").strip()
            if item and line.startswith("- "):
                issues.append(
                    {
                        "title": f"Research task: {item[:80]}",
                        "body": f"Source: `docs/execution_plan/todo.md`\n\n{item}",
                        "labels": "research,todo",
                    }
                )
    milestone_path = root / "docs/execution_plan/milestones.md"
    if milestone_path.exists():
        for line in milestone_path.read_text(encoding="utf-8").splitlines():
            if not line.startswith("| M"):
                continue
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if len(cells) >= 2:
                issues.append(
                    {
                        "title": f"Milestone: {cells[0]} {cells[1]}",
                        "body": f"Source: `docs/execution_plan/milestones.md`\n\nExit criteria: {cells[2] if len(cells) > 2 else 'TODO'}",
                        "labels": "research,milestone",
                    }
                )
    return issues
