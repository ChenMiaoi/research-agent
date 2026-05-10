"""Deterministic workflow and skill registry for Idea2Repo."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .scoring import Diagnosis


SkillHandler = Callable[[Diagnosis], str]


@dataclass(frozen=True)
class Skill:
    """A deterministic skill that produces one stable artifact."""

    name: str
    artifact: str
    handler: SkillHandler


def skill_registry() -> dict[str, Skill]:
    skills = [
        Skill("venue_router", "docs/workflow/venue_routing.md", _venue_routing),
        Skill("literature_radar", "docs/workflow/literature_radar.md", _literature_radar),
        Skill("novelty_checker", "docs/workflow/novelty_check.md", _novelty_check),
        Skill("scorecard_generator", "docs/workflow/scorecard.md", _scorecard),
        Skill("experiment_designer", "docs/workflow/experiment_design.md", _experiment_design),
        Skill("reviewer_simulator", "docs/workflow/reviewer_simulation.md", _reviewer),
        Skill("paper_template_generator", "docs/workflow/paper_skeleton.md", _paper_skeleton),
        Skill("rebuttal_assistant", "docs/workflow/rebuttal_plan.md", _rebuttal),
        Skill("weekly_project_manager", "docs/workflow/weekly_management.md", _weekly),
    ]
    return {skill.name: skill for skill in skills}


def run_workflow(diagnosis: Diagnosis) -> dict[str, str]:
    return {
        skill.artifact: skill.handler(diagnosis)
        for skill in skill_registry().values()
    }


def workflow_summary() -> str:
    lines = [
        "# Workflow",
        "",
        "Idea2Repo v0.1 uses deterministic workflow-first skills. Future model-backed skills must preserve these artifact contracts.",
        "",
        "| Skill | Artifact |",
        "| --- | --- |",
    ]
    for skill in skill_registry().values():
        lines.append(f"| `{skill.name}` | `{skill.artifact}` |")
    return "\n".join(lines) + "\n"


def _venue_routing(diagnosis: Diagnosis) -> str:
    lines = ["# Venue Routing", ""]
    for route in diagnosis.routes:
        lines.append(f"- {route.domain.label}: score={route.score}, requested={route.requested}")
    return "\n".join(lines) + "\n"


def _literature_radar(diagnosis: Diagnosis) -> str:
    route = diagnosis.routes[0]
    return f"""# Literature Radar

Primary domain: {route.domain.label}

Start with verified literature only:
- Search recent papers in {", ".join(route.domain.primary_venues[:3])}.
- Fill `docs/reference/related_work_matrix.csv`.
- Mark collision risk before claiming novelty.
"""


def _novelty_check(diagnosis: Diagnosis) -> str:
    return f"""# Novelty Check

- Raw novelty score: {diagnosis.raw_score.dimensions["novelty"]} / 20
- Revised novelty score: {diagnosis.revised_score.dimensions["novelty"]} / 20
- Evidence gate: {"ready" if diagnosis.evidence_gate.submission_ready else "blocked"}
- Next check: compare against verified recent related work, not generated prose.
"""


def _scorecard(diagnosis: Diagnosis) -> str:
    lines = [
        "# Scorecard",
        "",
        f"- Raw score: {diagnosis.raw_score.total} / 100",
        f"- Revised potential score: {diagnosis.revised_score.total} / 100",
        f"- Evidence gate: {'ready' if diagnosis.evidence_gate.submission_ready else 'blocked'}",
        "",
        "Readiness depends on evidence artifacts, not score alone.",
    ]
    return "\n".join(lines) + "\n"


def _experiment_design(diagnosis: Diagnosis) -> str:
    return "# Experiment Design\n\n" + "\n".join(
        f"- {item}" for item in diagnosis.required_evidence
    ) + "\n"


def _reviewer(diagnosis: Diagnosis) -> str:
    return "# Reviewer Simulation Workflow\n\n" + "\n".join(
        f"- Risk: {risk}" for risk in diagnosis.risks
    ) + "\n"


def _paper_skeleton(diagnosis: Diagnosis) -> str:
    return f"""# Paper Skeleton Workflow

- Title candidates stay TODO until related work is verified.
- Contributions must map to `docs/reference/claim_evidence_matrix.csv`.
- Security scope: {diagnosis.security_assessment.scope}
"""


def _rebuttal(diagnosis: Diagnosis) -> str:
    return """# Rebuttal Plan

- Paste reviews into this artifact only after submission feedback exists.
- Cluster concerns by novelty, soundness, significance, reproducibility, and ethics.
- Separate text-only responses from responses requiring new evidence.
"""


def _weekly(diagnosis: Diagnosis) -> str:
    return f"""# Weekly Management

- Current week: 1
- Next action: verify related work and baselines.
- Blocking reasons: {", ".join(diagnosis.evidence_gate.blocking_reasons) or "none"}
"""
