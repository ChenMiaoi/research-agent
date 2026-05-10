"""Generate an Idea2Repo CCF-A readiness research repository."""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from datetime import date
from io import StringIO
from pathlib import Path

from .evidence import EvidenceGate, evidence_gate_markdown, evaluate_evidence_gate
from .literature import PaperRecord, literature_tasks_md, references_bib, related_work_csv
from .permissions import Operation, PermissionPolicy, default_policy
from .providers import provider_schema_json, safe_provider_report
from .scoring import Diagnosis, ScoreBreakdown, diagnose_idea
from .security import safe_security_reframe, security_guardrail_markdown
from .state import RUN_LOG_PATH, append_run_log, read_manifest, write_manifest
from .workspace import inspect_workspace


@dataclass(frozen=True)
class GeneratedProject:
    """Result of a repo generation run."""

    root: Path
    project_name: str
    files: tuple[Path, ...]
    diagnosis: Diagnosis


def generate_research_repo(
    idea: str,
    output: str | Path,
    *,
    requested_domains: list[str] | None = None,
    timeline_weeks: int = 12,
    resources: list[str] | None = None,
    force: bool = False,
    created_at: str | None = None,
    permission_policy: PermissionPolicy | None = None,
    verified_papers: list[PaperRecord] | None = None,
    literature_tasks: list[str] | None = None,
    baselines: list[str] | None = None,
    datasets: list[str] | None = None,
    metrics: list[str] | None = None,
    claim_evidence_rows: list[dict[str, str]] | None = None,
    stack: str = "python",
) -> GeneratedProject:
    """Generate a CCF-A readiness repository for a raw research idea."""

    if not idea.strip():
        raise ValueError("idea must not be empty")
    if timeline_weeks not in {8, 12, 16, 24}:
        raise ValueError("timeline_weeks must be one of: 8, 12, 16, 24")
    if stack not in {"python", "ts"}:
        raise ValueError("stack must be one of: python, ts")

    root = Path(output)
    permission_policy = permission_policy or default_policy(allow_overwrite=force)
    if root.exists() and any(root.iterdir()) and not force:
        raise FileExistsError(f"output directory already exists and is not empty: {root}")
    if root.exists() and any(root.iterdir()):
        permission_policy.require(Operation.OVERWRITE, str(root))
    permission_policy.require(Operation.WRITE, str(root))

    created_at = created_at or date.today().isoformat()
    evidence_gate = evaluate_evidence_gate(
        verified_papers,
        baselines=baselines,
        datasets=datasets,
        metrics=metrics,
        claim_evidence_rows=claim_evidence_rows,
    )
    diagnosis = diagnose_idea(
        idea,
        requested_domains=requested_domains,
        verified_papers=verified_papers,
        baselines=baselines,
        datasets=datasets,
        metrics=metrics,
        claim_evidence_rows=claim_evidence_rows,
    )
    artifact_idea = safe_security_reframe(idea, diagnosis.security_assessment)
    project_name = slugify(root.name if root.name else idea)
    workspace = inspect_workspace()
    files = _build_files(
        project_name,
        artifact_idea,
        diagnosis,
        created_at,
        timeline_weeks,
        resources or [],
        workspace.as_dict(),
        verified_papers or [],
        literature_tasks or [],
        claim_evidence_rows,
        evidence_gate,
        stack,
    )

    written: list[Path] = []
    for relative_path, content in files.items():
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        written.append(path)

    for directory in _empty_directories():
        directory_path = root / directory
        directory_path.mkdir(parents=True, exist_ok=True)
        keep_file = directory_path / ".gitkeep"
        keep_file.write_text("", encoding="utf-8", newline="\n")
        written.append(keep_file)

    manifest_path = write_manifest(
        root,
        project_name=project_name,
        idea=artifact_idea,
        requested_domains=requested_domains,
        timeline_weeks=timeline_weeks,
        resources=resources or [],
        stack=stack,
        created_at=created_at,
        files=written,
        permissions=permission_policy.as_dict(),
        workspace=workspace.as_dict(),
    )
    written.append(manifest_path)
    written.append(root / RUN_LOG_PATH)

    return GeneratedProject(
        root=root,
        project_name=project_name,
        files=tuple(written),
        diagnosis=diagnosis,
    )


def resume_research_repo(
    output: str | Path,
    *,
    force: bool = False,
    permission_policy: PermissionPolicy | None = None,
) -> GeneratedProject:
    """Resume a generated repo by restoring only missing generated artifacts."""

    root = Path(output)
    permission_policy = permission_policy or default_policy(allow_overwrite=force)
    permission_policy.require(Operation.WRITE, str(root / RUN_LOG_PATH))
    if force:
        permission_policy.require(Operation.OVERWRITE, str(root))
    manifest = read_manifest(root)
    append_run_log(root, "resume_started", {"force": force})
    result = _regenerate_from_request(
        root,
        manifest,
        force=force,
        permission_policy=permission_policy,
    )
    append_run_log(root, "resume_completed", {"files": len(result.files)})
    return result


def _regenerate_from_request(
    root: Path,
    manifest: dict[str, object],
    *,
    force: bool,
    permission_policy: PermissionPolicy,
) -> GeneratedProject:
    request = dict(manifest.get("request", {}))
    idea = str(request.get("idea", "")).strip()
    if not idea:
        raise ValueError("manifest request is missing idea text")
    requested_domains = [
        str(value)
        for value in request.get("requested_domains", [])
        if str(value).strip()
    ]
    timeline_weeks = int(request.get("timeline_weeks", 12))
    stack = str(request.get("stack", "python"))
    if stack not in {"python", "ts"}:
        stack = "python"
    resources = [
        str(value)
        for value in request.get("resources", [])
        if str(value).strip()
    ]
    diagnosis = diagnose_idea(idea, requested_domains=requested_domains)
    artifact_idea = safe_security_reframe(idea, diagnosis.security_assessment)
    project_name = str(manifest.get("project_name") or slugify(root.name if root.name else idea))
    workspace = dict(manifest.get("workspace") or inspect_workspace().as_dict())
    created_at = str(manifest.get("created_at") or date.today().isoformat())
    files = _build_files(
        project_name,
        artifact_idea,
        diagnosis,
        created_at,
        timeline_weeks,
        resources,
        workspace,
        [],
        [],
        None,
        evaluate_evidence_gate(),
        stack,
    )
    written: list[Path] = []
    for relative_path, content in files.items():
        path = root / relative_path
        if path.exists() and not force:
            continue
        if path.exists():
            permission_policy.require(Operation.OVERWRITE, str(path))
        permission_policy.require(Operation.WRITE, str(path))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        written.append(path)
    for directory in _empty_directories():
        directory_path = root / directory
        keep_file = directory_path / ".gitkeep"
        if keep_file.exists() and not force:
            continue
        if keep_file.exists():
            permission_policy.require(Operation.OVERWRITE, str(keep_file))
        permission_policy.require(Operation.WRITE, str(keep_file))
        directory_path.mkdir(parents=True, exist_ok=True)
        keep_file.write_text("", encoding="utf-8", newline="\n")
        written.append(keep_file)
    if force:
        manifest_path = write_manifest(
            root,
            project_name=project_name,
            idea=artifact_idea,
            requested_domains=requested_domains,
            timeline_weeks=timeline_weeks,
            resources=resources,
            stack=stack,
            created_at=created_at,
            files=written,
            permissions=permission_policy.as_dict(),
            workspace=workspace,
        )
        written.append(manifest_path)
    return GeneratedProject(root=root, project_name=project_name, files=tuple(written), diagnosis=diagnosis)


def slugify(value: str) -> str:
    """Create a conservative cross-platform project slug."""

    normalized = re.sub(r"[^A-Za-z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized[:64] or "idea2repo-project"


def _build_files(
    project_name: str,
    idea: str,
    diagnosis: Diagnosis,
    created_at: str,
    timeline_weeks: int,
    resources: list[str],
    workspace: dict[str, object] | None = None,
    verified_papers: list[PaperRecord] | None = None,
    literature_tasks: list[str] | None = None,
    claim_evidence_rows: list[dict[str, str]] | None = None,
    evidence_gate: EvidenceGate | None = None,
    stack: str = "python",
) -> dict[Path, str]:
    primary_route = diagnosis.routes[0]
    primary_domain = primary_route.domain
    primary_venues = ", ".join(primary_domain.primary_venues)
    cap_values = ", ".join(trigger.value for trigger in diagnosis.raw_score.cap_triggers) or "none"
    revised_cap_values = (
        ", ".join(trigger.value for trigger in diagnosis.revised_score.cap_triggers)
        or "none"
    )

    files = {
        Path("README.md"): _root_readme(project_name, idea, diagnosis),
        Path(".gitignore"): _generated_gitignore(),
        Path(".dockerignore"): _generated_dockerignore(),
        Path(".env.example"): _env_example(),
        Path("project.yaml"): _project_yaml(
            project_name,
            idea,
            diagnosis,
            created_at,
            timeline_weeks,
            resources,
        ),
        Path("requirements.txt"): _requirements_txt(),
        Path("pyproject.toml"): _generated_pyproject(project_name),
        Path("docs/diagnosis/ccf_a_readiness_report.md"): _readiness_report(
            project_name,
            idea,
            diagnosis,
            primary_venues,
            cap_values,
            revised_cap_values,
            timeline_weeks,
        ),
        Path("docs/diagnosis/raw_idea_score.md"): _score_report(
            "Raw Idea Score",
            diagnosis.raw_score,
        ),
        Path("docs/diagnosis/revised_plan_score.md"): _score_report(
            "Revised Plan Score",
            diagnosis.revised_score,
        ),
        Path("docs/diagnosis/evidence_gate.md"): evidence_gate_markdown(
            evidence_gate or diagnosis.evidence_gate
        ),
        Path("docs/diagnosis/security_guardrail.md"): security_guardrail_markdown(
            diagnosis.security_assessment
        ),
        Path("docs/diagnosis/risk_register.md"): _risk_register(diagnosis),
        Path("docs/diagnosis/reviewer_simulation.md"): _reviewer_simulation(diagnosis),
        Path("docs/survey/survey.md"): _survey(diagnosis),
        Path("docs/survey/paper_map.md"): _paper_map(),
        Path("docs/survey/topic_clusters.md"): _topic_clusters(),
        Path("docs/survey/trend_analysis.md"): _trend_analysis(),
        Path("docs/survey/open_problems.md"): _open_problems(diagnosis),
        Path("docs/reference/references.bib"): references_bib(verified_papers or []),
        Path("docs/reference/related_work_matrix.csv"): related_work_csv(verified_papers or []),
        Path("docs/reference/literature_search_tasks.md"): literature_tasks_md(literature_tasks or []),
        Path("docs/reference/claim_evidence_matrix.csv"): _csv(
            _claim_evidence_rows(claim_evidence_rows)
        ),
        Path("docs/reference/paper_notes/README.md"): _paper_notes_readme(),
        Path("docs/reference/pdfs/README.md"): _pdf_readme(),
        Path(f"docs/execution_plan/{timeline_weeks}_week_plan.md"): _timeline_plan(
            diagnosis,
            timeline_weeks,
            resources,
        ),
        Path("docs/execution_plan/milestones.md"): _milestones(),
        Path("docs/execution_plan/todo.md"): _todo(diagnosis),
        Path("docs/execution_plan/compute_budget.md"): _compute_budget(
            primary_domain.key,
            resources,
        ),
        Path("docs/execution_plan/experiment_checklist.md"): _experiment_checklist(
            primary_domain.key
        ),
        Path("docs/meeting/weekly_update_template.md"): _weekly_update_template(),
        Path("docs/meeting/advisor_report.md"): _advisor_report(diagnosis),
        Path("docs/runtime/platform_notes.md"): _platform_notes(),
        Path("docs/runtime/provider_config.md"): _provider_config(),
        Path("docs/runtime/provider_schema.json"): provider_schema_json(),
        Path("docs/runtime/workspace_snapshot.md"): _workspace_snapshot(workspace or {}),
        Path("paper/main.tex"): _main_tex(project_name),
        Path("paper/macros.tex"): _macros_tex(),
        Path("paper/sections/00_abstract.tex"): _section_tex("Abstract"),
        Path("paper/sections/01_introduction.tex"): _introduction_tex(diagnosis),
        Path("paper/sections/02_related_work.tex"): _related_work_tex(),
        Path("paper/sections/03_problem_formulation.tex"): _section_tex(
            "Problem Formulation"
        ),
        Path("paper/sections/04_method.tex"): _section_tex("Method"),
        Path("paper/sections/05_experiments.tex"): _experiments_tex(primary_domain.key),
        Path("paper/sections/06_discussion.tex"): _section_tex("Discussion"),
        Path("paper/sections/07_conclusion.tex"): _section_tex("Conclusion"),
        Path("src/README.md"): _src_readme(),
        Path("src/research_project/__init__.py"): _research_init(),
        Path("src/research_project/runner.py"): _research_runner(),
        Path("src/research_project/result_logger.py"): _result_logger_py(),
        Path("src/method/README.md"): _component_readme("method implementation"),
        Path("src/baselines/README.md"): _component_readme("baseline reproductions"),
        Path("src/evaluation/README.md"): _component_readme("evaluation code"),
        Path("src/utils/README.md"): _component_readme("shared utilities"),
        Path("experiments/README.md"): _experiments_readme(),
        Path("configs/README.md"): _configs_readme(),
        Path("data/README.md"): _data_readme(),
        Path("results/README.md"): _results_readme(),
        Path("scripts/README.md"): _scripts_readme(),
        Path("scripts/run.sh"): _run_sh(),
        Path("scripts/run.ps1"): _run_ps1(),
        Path("tests/test_smoke.py"): _generated_smoke_test(),
        Path("docker/Dockerfile"): _dockerfile(),
        Path("docker/docker-compose.yml"): _docker_compose(),
        Path(".github/workflows/ci.yml"): _github_ci(stack),
        Path(".github/workflows/README.md"): _github_workflows_readme(),
        Path(".github/ISSUE_TEMPLATE/research_task.md"): _issue_template(),
    }
    if stack == "ts":
        files.update(
            {
                Path("package.json"): _package_json(project_name),
                Path("tsconfig.json"): _tsconfig_json(),
                Path("src/index.ts"): _ts_index(),
                Path("tests/smoke.test.ts"): _ts_smoke_test(),
            }
        )
    return files


def _empty_directories() -> tuple[Path, ...]:
    return (
        Path("paper/figures"),
        Path("paper/tables"),
        Path("data/raw"),
        Path("data/processed"),
        Path("results/logs"),
        Path("results/tables"),
        Path("results/figures"),
        Path("experiments/exp_001_baseline_reproduction"),
        Path("experiments/exp_002_main_result"),
        Path("experiments/exp_003_ablation"),
        Path("experiments/exp_004_scalability_or_robustness"),
        Path("experiments/exp_005_failure_cases"),
    )


def _root_readme(project_name: str, idea: str, diagnosis: Diagnosis) -> str:
    route = diagnosis.routes[0]
    return f"""# {project_name}

CCF-A readiness research repository generated by Idea2Repo.

## Raw Idea

{idea}

## Current Diagnosis

- Primary route: {route.domain.label}
- Candidate venues: {", ".join(route.domain.primary_venues)}
- Raw idea score: {diagnosis.raw_score.total} / 100
- Revised plan score: {diagnosis.revised_score.total} / 100
- Main report: `docs/diagnosis/ccf_a_readiness_report.md`

## Grounding Policy

This repo intentionally contains placeholders for papers and experiments. Add only verified
papers with traceable links and BibTeX. Do not write experimental claims until the evidence
exists in `results/`.
"""


def _generated_gitignore() -> str:
    return """# Python / runtime caches
__pycache__/
*.py[cod]
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
coverage.xml
htmlcov/

# Local environments and credentials
.env
.env.*
!.env.example
!.env.sample
.venv/
venv/
.envrc
.direnv/
secrets/
*.pem
*.key
*.crt
*.p12
*.pfx
*.jks
*.keystore
*.token
*.secret
credentials.json
token.json

# Node / frontend caches if this repo grows a web UI
node_modules/
dist/
.vite/
.turbo/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
coverage/
.fastapi/
.uvicorn/
.cache/
.web-cache/

# Research data and generated outputs kept out by default
generated_repos/
.idea2repo/
data/raw/*
data/processed/*
results/logs/*
results/tables/*
results/figures/*
!data/raw/.gitkeep
!data/processed/.gitkeep
!results/logs/.gitkeep
!results/tables/.gitkeep
!results/figures/.gitkeep
artifacts/
runs/
outputs/

# Literature PDFs and large local datasets
docs/reference/pdfs/*
!docs/reference/pdfs/README.md
datasets/
pdfs/

# Large model and experiment artifacts
checkpoints/
models/
wandb/
mlruns/
*.ckpt
*.pt
*.pth
*.safetensors
*.onnx
*.gguf
*.parquet
*.feather
*.arrow
*.zip
*.tar
*.tar.gz
*.7z

# Local databases and logs
*.sqlite
*.sqlite3
*.db
*.log
*.tmp
*.pid
*.trace
*.prof
*.har

# OS and editor noise
.DS_Store
Thumbs.db
.idea/
.vscode/
*.swp
*.swo
"""


def _generated_dockerignore() -> str:
    return """# Keep secrets and local state out of Docker build contexts.
.git
.env
.env.*
!.env.example
secrets/
*.pem
*.key
*.crt
*.p12
*.pfx
*.jks
*.keystore
*.token
*.secret
.envrc
.direnv/
credentials.json
token.json
.codex/sessions/
.codex/auth/

# Dependency and build caches
__pycache__/
*.py[cod]
.pytest_cache/
.mypy_cache/
.ruff_cache/
.venv/
venv/
node_modules/
dist/
.vite/
.turbo/
.fastapi/
.uvicorn/
.cache/
.web-cache/

# Large research artifacts
data/raw/
data/processed/
results/
artifacts/
runs/
outputs/
checkpoints/
models/
wandb/
mlruns/
datasets/
pdfs/
docs/reference/pdfs/
*.ckpt
*.pt
*.pth
*.safetensors
*.onnx
*.gguf
*.parquet
*.zip
*.tar
*.tar.gz
*.7z

# Local databases and logs
*.sqlite
*.sqlite3
*.db
*.log
*.tmp
*.pid
*.trace
*.prof
*.har
"""


def _env_example() -> str:
    return """# Copy to .env for local experiments. Never commit real secrets.
IDEA2REPO_PROVIDER=offline
# Supported modes: offline, openai_account, openai_api_key, enterprise_gateway, local_model
OPENAI_API_KEY=
OPENAI_BASE_URL=
ENTERPRISE_GATEWAY_URL=
LOCAL_MODEL_ENDPOINT=
"""


def _project_yaml(
    project_name: str,
    idea: str,
    diagnosis: Diagnosis,
    created_at: str,
    timeline_weeks: int,
    resources: list[str],
) -> str:
    route = diagnosis.routes[0]
    domain = route.domain
    raw_caps = [trigger.value for trigger in diagnosis.raw_score.cap_triggers]
    revised_caps = [trigger.value for trigger in diagnosis.revised_score.cap_triggers]
    venues = domain.primary_venues[:3]
    return f"""project:
  name: {project_name}
  created_at: {created_at}
  owner: user
  stage: idea_diagnosis

idea:
  raw_text: |
{_indent(idea, 4)}
  parsed_problem: {_yaml_scalar(diagnosis.parsed_idea.problem)}
  proposed_method: {_yaml_scalar(diagnosis.parsed_idea.proposed_method)}
  timeline_weeks: {timeline_weeks}
  resource_constraints:
{_yaml_list(resources or ["unspecified"], 4)}
  target_domain:
{_yaml_list([domain.key], 4)}
  target_venues:
{_yaml_list(list(venues), 4)}

runtime:
  platforms:
{_yaml_list(["windows", "linux", "macos"], 4)}
  cli_behavior_references:
{_yaml_list(["openai_codex_cli", "claude_cli"], 4)}
  auth:
    primary: openai_account_login
    supported_subscriptions:
{_yaml_list(["plus", "pro"], 6)}
    fallback_providers:
{_yaml_list(["openai_api_key", "enterprise_account", "local_model"], 6)}

scores:
  raw_idea_score: {diagnosis.raw_score.total}
  revised_plan_score: {diagnosis.revised_score.total}
  raw_score_caps:
{_yaml_list(raw_caps or ["none"], 4)}
  revised_score_caps:
{_yaml_list(revised_caps or ["none"], 4)}

artifacts:
  diagnosis_report: docs/diagnosis/ccf_a_readiness_report.md
  survey: docs/survey/survey.md
  related_work_matrix: docs/reference/related_work_matrix.csv
  bibtex: docs/reference/references.bib
  execution_plan: docs/execution_plan/{timeline_weeks}_week_plan.md
  paper_template: paper/main.tex

status:
  next_action: verify_recent_related_work
  current_week: 1
"""


def _readiness_report(
    project_name: str,
    idea: str,
    diagnosis: Diagnosis,
    primary_venues: str,
    cap_values: str,
    revised_cap_values: str,
    timeline_weeks: int,
) -> str:
    route = diagnosis.routes[0]
    parsed = diagnosis.parsed_idea
    return f"""# CCF-A Readiness Report

## 1. Executive Summary

- Project: {project_name}
- Raw Idea Score: {diagnosis.raw_score.total} / 100
- Revised Plan Score: {diagnosis.revised_score.total} / 100
- Primary route: {route.domain.label}
- Candidate venues: {primary_venues}
- Security scope: {diagnosis.security_assessment.scope}
- Raw score caps: {cap_values}
- Revised score caps: {revised_cap_values}
- CCF-A scoring track: Full / Regular papers only; workshop, demo, and short-paper targets are capped.
- Biggest risk: {diagnosis.risks[0]}
- Most important next action: verify recent related work and fill the collision matrix.

## 2. Parsed Research Idea

- Problem: {parsed.problem}
- Motivation: {parsed.motivation}
- Proposed Method: {parsed.proposed_method}
- Expected Contribution: {parsed.expected_contribution}
- Target User / Scenario: {parsed.target_scenario}

## 3. Target Venue Routing

Primary route: **{route.domain.label}**

Recommended primary venues: {primary_venues}

Reviewer focus:
{_markdown_list(route.domain.review_focus)}

## 4. Related Work Map

No paper claims have been populated yet. Use `docs/reference/related_work_matrix.csv`
to add only verified papers from traceable sources.

## 5. Difference Matrix

See `docs/reference/related_work_matrix.csv`. Treat `collision_risk` as the key field:
High means the idea may already be done; Opportunity means the paper exposes a gap.

## 6. Novelty Diagnosis

- Possible novelty: the revised plan must define a falsifiable gap against recent work.
- Collision risk: unknown until the matrix is filled with verified papers.
- Novelty score: {diagnosis.raw_score.dimensions["novelty"]} / 20 raw, {diagnosis.revised_score.dimensions["novelty"]} / 20 revised.

## 7. Feasibility Diagnosis

Required evidence:
{_markdown_list(diagnosis.required_evidence)}

## 8. Revised Research Plan

{diagnosis.revised_plan_text}

## 9. CCF-A Scorecard

Submission readiness gate: {"ready" if diagnosis.evidence_gate.submission_ready else "blocked"}

Blocking reasons: {", ".join(diagnosis.evidence_gate.blocking_reasons) or "none"}

### Raw

{_score_table(diagnosis.raw_score)}

### Revised

{_score_table(diagnosis.revised_score)}

## 10. Execution Plan

See `docs/execution_plan/{timeline_weeks}_week_plan.md`.

## 11. Paper Skeleton

See `paper/main.tex` and `paper/sections/`.

## 12. Next Actions

- Add 10-20 verified recent papers to the related-work matrix.
- Pick 3-5 strong baselines and reproduction order.
- Freeze the first benchmark, dataset, and metric set.
- Fill the claim-evidence matrix before writing performance claims.
"""


def _score_report(title: str, score: ScoreBreakdown) -> str:
    caps = ", ".join(trigger.value for trigger in score.cap_triggers) or "none"
    return f"""# {title}

- Final score: {score.total} / 100
- Uncapped score: {score.uncapped_total} / 100
- Cap limit: {score.cap_limit if score.cap_limit is not None else "none"}
- Cap triggers: {caps}

{_score_table(score)}
"""


def _score_table(score: ScoreBreakdown) -> str:
    lines = ["| Dimension | Score |", "| --- | ---: |"]
    for dimension, value in score.dimensions.items():
        lines.append(f"| {dimension} | {value} |")
    return "\n".join(lines)


def _claim_evidence_rows(rows: list[dict[str, str]] | None) -> list[list[str]]:
    header = ["claim", "required_evidence", "planned_artifact", "status"]
    if not rows:
        return [
            header,
            ["TODO: primary claim", "TODO: dataset + metric + baseline", "results/tables/", "planned"],
            ["TODO: limitation claim", "TODO: failure cases", "results/figures/", "planned"],
        ]
    return [
        header,
        *[
            [
                row.get("claim", ""),
                row.get("required_evidence", ""),
                row.get("planned_artifact", ""),
                row.get("status", ""),
            ]
            for row in rows
        ],
    ]


def _risk_register(diagnosis: Diagnosis) -> str:
    lines = [
        "# Risk Register",
        "",
        "| Risk | Impact | Mitigation |",
        "| --- | --- | --- |",
    ]
    for risk in diagnosis.risks:
        lines.append(f"| {risk} | High | Add evidence before making claims. |")
    return "\n".join(lines) + "\n"


def _reviewer_simulation(diagnosis: Diagnosis) -> str:
    route = diagnosis.routes[0]
    return f"""# Reviewer Simulation

## Summary

The idea is routed to {route.domain.label}. It has potential only if the related-work
collision check, baseline reproduction, and experiment plan are completed.

## Strengths

- The revised plan creates a concrete route from idea to evidence.
- The repository separates claims, references, experiments, and paper writing.

## Weaknesses

{_markdown_list(diagnosis.risks)}

## Questions

- Which recent papers already solve the same problem?
- Which baseline would a skeptical reviewer expect first?
- What evidence would falsify the main claim?

## Required Fixes Before Submission

{_markdown_list(diagnosis.required_evidence)}

Confidence: Medium until verified references and baseline results are added.
"""


def _survey(diagnosis: Diagnosis) -> str:
    route = diagnosis.routes[0]
    return f"""# Survey

## Scope

Primary domain: {route.domain.label}

This survey must be filled with real, traceable papers. Start with recent work from
the last 3-5 years, then add canonical papers that define the problem.

## Initial Search Queries

- "{diagnosis.parsed_idea.problem}" benchmark baseline
- "{diagnosis.parsed_idea.problem}" related work
- "{route.domain.primary_venues[0]}" "{diagnosis.parsed_idea.problem}"
- "2025" "{diagnosis.parsed_idea.problem}"

## Cluster Template

For each cluster, record the core problem, method pattern, datasets, baselines, metrics,
limitations, and collision risk with the current idea.
"""


def _paper_map() -> str:
    return """# Paper Map

Add verified papers as nodes. Group them by method, task, dataset, and venue.

| Cluster | Representative Papers | Core Question | Collision Risk |
| --- | --- | --- | --- |
| TODO | TODO | TODO | TODO |
"""


def _topic_clusters() -> str:
    return """# Topic Clusters

| Cluster | Problem | Method Pattern | Common Data | Open Gap |
| --- | --- | --- | --- | --- |
| TODO | TODO | TODO | TODO | TODO |
"""


def _trend_analysis() -> str:
    return """# Trend Analysis

Fill this only after the related-work matrix contains verified recent papers.

- 2024 themes: TODO
- 2025 themes: TODO
- 2026 themes: TODO
- Saturated directions: TODO
- Emerging gaps: TODO
"""


def _open_problems(diagnosis: Diagnosis) -> str:
    return f"""# Open Problems

Candidate open problems derived from the current diagnosis:

{_markdown_list(diagnosis.required_evidence)}

Replace these with evidence-backed gaps after literature verification.
"""


def _references_bib() -> str:
    return """% Add only verified BibTeX entries.
% Do not invent paper titles, authors, venues, years, or URLs.
"""


def _paper_notes_readme() -> str:
    return """# Paper Notes

Create one markdown file per verified paper. Use the structured fields from
`docs/reference/related_work_matrix.csv`.
"""


def _pdf_readme() -> str:
    return """# PDFs

Store PDFs only when the license and source terms allow local storage. Otherwise keep links
in the reference matrix.
"""


def _timeline_plan(
    diagnosis: Diagnosis,
    timeline_weeks: int,
    resources: list[str],
) -> str:
    base_weeks = [
        ("1", "Verify 10-20 recent related papers and fill collision risk."),
        ("2", "Finalize problem statement, threat/system/agent-specific rubric, and baselines."),
        ("3", "Reproduce the first baseline and lock data splits or workloads."),
        ("4", "Reproduce remaining high-priority baselines."),
        ("5", "Prototype the proposed method or system."),
        ("6", "Run a small end-to-end sanity evaluation."),
        ("7", "Run main experiments and log failures."),
        ("8", "Run ablations, robustness, or scalability checks."),
        ("9", "Analyze results and update claim-evidence matrix."),
        ("10", "Draft introduction, method, and experiment sections."),
        ("11", "Run reviewer simulation and patch missing evidence."),
        ("12", "Prepare submission checklist, appendix, and reproducibility notes."),
    ]
    weeks = _scale_plan(base_weeks, timeline_weeks)
    resource_text = ", ".join(resources) if resources else "unspecified"
    lines = [f"# {timeline_weeks} Week Plan", "", f"Resource constraints: {resource_text}", ""]
    for week, deliverable in weeks:
        lines.append(f"## Week {week}")
        lines.append("")
        lines.append(f"- Deliverable: {deliverable}")
        lines.append("- Exit criteria: artifact committed under `docs/`, `experiments/`, or `results/`.")
        lines.append("")
    lines.append("## Evidence Priorities")
    lines.append("")
    lines.append(_markdown_list(diagnosis.required_evidence))
    return "\n".join(lines)


def _scale_plan(base_weeks: list[tuple[str, str]], timeline_weeks: int) -> list[tuple[str, str]]:
    if timeline_weeks == 12:
        return base_weeks
    if timeline_weeks == 8:
        return [
            ("1", "Verify core related papers and collision risk."),
            ("2", "Finalize problem, baselines, datasets, and metrics."),
            ("3", "Reproduce the first strong baseline."),
            ("4", "Prototype the proposed method or system."),
            ("5", "Run main experiments and log failures."),
            ("6", "Run ablations, robustness, or scalability checks."),
            ("7", "Update claim-evidence matrix and draft core sections."),
            ("8", "Run reviewer simulation and prepare reproducibility notes."),
        ]
    if timeline_weeks == 16:
        return base_weeks + [
            ("13", "Expand related-work coverage and patch collision risks."),
            ("14", "Run additional stress, robustness, or generalization checks."),
            ("15", "Polish paper narrative, appendix, and artifact documentation."),
            ("16", "Run final reviewer simulation and submission checklist."),
        ]
    return base_weeks + [
        ("13-16", "Broaden benchmark coverage and strengthen baselines."),
        ("17-20", "Run larger-scale validation and artifact hardening."),
        ("21-22", "Draft full paper and reproducibility appendix."),
        ("23-24", "Run final reviewer simulation, rebuttal prep, and release checks."),
    ]


def _milestones() -> str:
    return """# Milestones

| Milestone | Exit Criteria | Status |
| --- | --- | --- |
| M1 Literature collision check | Related-work matrix has verified papers | Planned |
| M2 Baseline reproduction | At least one strong baseline reproduces | Planned |
| M3 Prototype | Proposed method runs end-to-end | Planned |
| M4 Main results | Claim-evidence matrix has real results | Planned |
| M5 Paper skeleton | All sections have evidence-backed TODOs or text | Planned |
"""


def _todo(diagnosis: Diagnosis) -> str:
    return "# TODO\n\n" + _markdown_list(
        [
            "Verify latest CCF and venue information before publication-critical claims.",
            "Fill `docs/reference/related_work_matrix.csv` with real papers.",
            "Fill `docs/reference/claim_evidence_matrix.csv` before writing claims.",
            *diagnosis.required_evidence,
        ]
    )


def _compute_budget(domain: str, resources: list[str]) -> str:
    if domain == "systems":
        focus = "Record hardware, workload scale, latency, throughput, memory, and cost."
    elif domain == "security":
        focus = "Record sandboxing, allowed targets, data handling, and defensive evaluation cost."
    else:
        focus = "Record model sizes, GPU hours, API cost, benchmark size, and random seeds."
    resource_text = ", ".join(resources) if resources else "unspecified"
    return f"""# Compute Budget

{focus}

User resource constraints: {resource_text}

| Resource | Estimate | Actual | Notes |
| --- | ---: | ---: | --- |
| CPU hours | TODO | TODO | TODO |
| GPU hours | TODO | TODO | TODO |
| API cost | TODO | TODO | TODO |
| Storage | TODO | TODO | TODO |
"""


def _experiment_checklist(domain: str) -> str:
    domain_items = {
        "security": [
            "Threat model is written before experiments.",
            "Evaluation is defensive or scoped and ethically bounded.",
            "False positives and false negatives are measured.",
        ],
        "systems": [
            "End-to-end throughput and latency are measured.",
            "Memory, scalability, and cost are measured.",
            "Microbenchmarks explain which design choice matters.",
        ],
        "ai_llm_agent": [
            "Ablations isolate each method component.",
            "Generalization or OOD checks are included.",
            "Failure cases are collected and categorized.",
        ],
    }
    common = [
        "Baselines are strong and reproducible.",
        "Datasets, workloads, and splits are documented.",
        "Metrics match the paper claims.",
        "Random seeds and environment details are logged.",
    ]
    return "# Experiment Checklist\n\n" + "\n".join(
        f"- [ ] {item}" for item in common + domain_items.get(domain, [])
    ) + "\n"


def _weekly_update_template() -> str:
    return """# Weekly Update

## Completed

- TODO

## Evidence Added

- TODO

## Risks

- TODO

## Next Week

- TODO
"""


def _advisor_report(diagnosis: Diagnosis) -> str:
    return f"""# Advisor Report

## Status

- Raw score: {diagnosis.raw_score.total} / 100
- Revised score: {diagnosis.revised_score.total} / 100

## Main Risks

{_markdown_list(diagnosis.risks)}

## Decisions Needed

- Confirm target venue family.
- Confirm baselines and first benchmark.
- Confirm compute and data constraints.
"""


def _platform_notes() -> str:
    return """# Platform Notes

The project should remain portable across Windows, Linux, and macOS.

- Avoid POSIX-only shell assumptions in core workflows.
- Document PowerShell, Git Bash, and Unix shell variants when scripts are added.
- Keep secrets in platform credential stores or `.env` files excluded from git.
- Do not depend on private login APIs or cookie scraping.
"""


def _provider_config() -> str:
    return safe_provider_report({})


def _workspace_snapshot(workspace: dict[str, object]) -> str:
    status_lines = workspace.get("git_status_short") or []
    if isinstance(status_lines, list) and status_lines:
        status_text = _markdown_list([str(line) for line in status_lines])
    else:
        status_text = "- clean or unavailable"
    return f"""# Workspace Snapshot

Generated from the local workspace context.

- Current directory: {workspace.get("cwd", "unknown")}
- Git root: {workspace.get("git_root", "not detected")}
- Git branch: {workspace.get("git_branch", "not detected")}
- Tracked files: {workspace.get("tracked_files", "unknown")}

## Git Status

{status_text}
"""


def _main_tex(project_name: str) -> str:
    title = project_name.replace("-", " ").title()
    return rf"""\documentclass{{article}}
\input{{macros}}

\title{{{title}}}
\author{{TODO}}
\date{{}}

\begin{{document}}
\maketitle

\input{{sections/00_abstract}}
\input{{sections/01_introduction}}
\input{{sections/02_related_work}}
\input{{sections/03_problem_formulation}}
\input{{sections/04_method}}
\input{{sections/05_experiments}}
\input{{sections/06_discussion}}
\input{{sections/07_conclusion}}

\bibliographystyle{{plain}}
\bibliography{{../docs/reference/references}}
\end{{document}}
"""


def _macros_tex() -> str:
    return r"""\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{hyperref}
\newcommand{\method}{\textsc{TODO}}
"""


def _section_tex(title: str) -> str:
    return rf"""\section{{{title}}}

% TODO: Write this section only with evidence from docs/reference and results.
"""


def _introduction_tex(diagnosis: Diagnosis) -> str:
    bullets = "\n".join(
        rf"    \item TODO: {item}" for item in diagnosis.required_evidence[:3]
    )
    return rf"""\section{{Introduction}}

% TODO: Explain the research problem and why the target community should care.
% TODO: State the gap only after verifying related work.

\paragraph{{Contributions.}}
\begin{{itemize}}
{bullets}
\end{{itemize}}
"""


def _related_work_tex() -> str:
    return r"""\section{Related Work}

% TODO: Use only papers listed in docs/reference/references.bib.
% TODO: Organize by problem, method, dataset, or assumption.
% TODO: For each cluster, state the difference from the current idea.
"""


def _experiments_tex(domain: str) -> str:
    if domain == "systems":
        extra = "% TODO: Report throughput, latency, memory, scalability, and cost."
    elif domain == "security":
        extra = "% TODO: Report threat model, scope, false positives, and false negatives."
    else:
        extra = "% TODO: Report main results, ablations, generalization, and failure cases."
    return rf"""\section{{Experiments}}

% TODO: Define datasets, workloads, metrics, and baselines before results.
{extra}
% TODO: Do not write performance claims until results exist.
"""


def _src_readme() -> str:
    return """# Source Code

Keep implementation code here. Separate proposed method, baselines, evaluation, and utilities.
"""


def _generated_pyproject(project_name: str) -> str:
    package = project_name.replace("-", "_")
    return f"""[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "{project_name}"
version = "0.1.0"
description = "Executable research scaffold generated by Idea2Repo."
requires-python = ">=3.10"
dependencies = []

[tool.setuptools]
package-dir = {{"" = "src"}}

[tool.setuptools.packages.find]
where = ["src"]
include = ["research_project*"]

[project.scripts]
{package} = "research_project.runner:main"
"""


def _research_init() -> str:
    return '"""Research project scaffold."""\n\n__all__ = ["__version__"]\n__version__ = "0.1.0"\n'


def _research_runner() -> str:
    return '''"""Cross-platform smoke entrypoint for the generated research project."""

from __future__ import annotations

from .result_logger import log_result


def main() -> int:
    log_result("smoke", {"status": "ok"})
    print("Idea2Repo research scaffold is ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


def _result_logger_py() -> str:
    return '''"""Lightweight JSONL result logger."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def log_result(name: str, payload: dict[str, Any], output: str | Path = "results/logs/results.jsonl") -> Path:
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "name": name,
        "payload": payload,
    }
    with path.open("a", encoding="utf-8", newline="\\n") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\\n")
    return path
'''


def _generated_smoke_test() -> str:
    return '''import unittest

from research_project.runner import main


class SmokeTests(unittest.TestCase):
    def test_smoke_entrypoint(self) -> None:
        self.assertEqual(main(), 0)


if __name__ == "__main__":
    unittest.main()
'''


def _component_readme(component: str) -> str:
    return f"# {component.title()}\n\nTODO: Add {component}.\n"


def _experiments_readme() -> str:
    return """# Experiments

Each experiment directory should contain config, command, logs, expected outputs, and notes.
"""


def _configs_readme() -> str:
    return """# Configs

Store experiment configuration files here. Prefer explicit seeds, dataset paths, and metrics.
"""


def _data_readme() -> str:
    return """# Data

Do not commit private, licensed, or large raw data. Document acquisition and preprocessing.
"""


def _results_readme() -> str:
    return """# Results

Store generated tables, figures, and logs here. Commit only lightweight evidence when appropriate.
"""


def _scripts_readme() -> str:
    return """# Scripts

Add cross-platform scripts only after documenting Windows, Linux, and macOS behavior.
"""


def _run_sh() -> str:
    return """#!/usr/bin/env sh
set -eu

uv run python -m research_project.runner
"""


def _run_ps1() -> str:
    return """$ErrorActionPreference = "Stop"

uv run python -m research_project.runner
"""


def _dockerfile() -> str:
    return """FROM python:3.12-slim
WORKDIR /workspace
RUN pip install --no-cache-dir uv
COPY . .
RUN uv sync
CMD ["uv", "run", "python", "-m", "research_project.runner"]
"""


def _docker_compose() -> str:
    return """services:
  research:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    working_dir: /workspace
    volumes:
      - ..:/workspace
"""


def _github_workflows_readme() -> str:
    return """# Workflows

CI runs the generated scaffold smoke tests. Extend it when real experiments are added.
"""


def _github_ci(stack: str) -> str:
    npm_steps = ""
    if stack == "ts":
        npm_steps = """
      - name: Install npm dependencies
        run: npm install
      - name: Run TypeScript smoke test
        run: npm test
"""
    return f"""name: CI

on:
  push:
  pull_request:

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - name: Run Python smoke tests
        run: uv run python -m unittest discover -s tests
{npm_steps}"""


def _package_json(project_name: str) -> str:
    return f"""{{
  "name": "{project_name}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {{
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "npm run build && node dist/tests/smoke.test.js"
  }},
  "devDependencies": {{
    "typescript": "^5.6.0"
  }}
}}
"""


def _tsconfig_json() -> str:
    return """{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
"""


def _ts_index() -> str:
    return """export function scaffoldStatus(): string {
  return "ready";
}
"""


def _ts_smoke_test() -> str:
    return """import { scaffoldStatus } from "../src/index.js";

if (scaffoldStatus() !== "ready") {
  throw new Error("scaffold is not ready");
}
"""


def _issue_template() -> str:
    return """---
name: Research task
about: Track literature, experiment, writing, or infrastructure work
title: "[Research] "
labels: research
assignees: ""
---

## Goal

TODO

## Evidence Required

TODO

## Done When

TODO
"""


def _requirements_txt() -> str:
    return """# Add runtime dependencies after the experiment stack is chosen.
"""


def _csv(rows: list[list[str]]) -> str:
    buffer = StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerows(rows)
    return buffer.getvalue()


def _markdown_list(items: tuple[str, ...] | list[str]) -> str:
    return "\n".join(f"- {item}" for item in items)


def _yaml_list(items: list[str], indent: int) -> str:
    prefix = " " * indent
    return "\n".join(f"{prefix}- {_yaml_scalar(item)}" for item in items)


def _yaml_scalar(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _indent(value: str, spaces: int) -> str:
    prefix = " " * spaces
    return "\n".join(prefix + line for line in value.splitlines() or [""])
