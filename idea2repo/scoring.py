"""Strict CCF-A readiness scoring for early research ideas."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from .evidence import EvidenceGate, evaluate_evidence_gate
from .literature import PaperRecord
from .security import SecurityAssessment, assess_security_scope, safe_security_reframe
from .venues import DomainRoute, VenueDatabase, load_venue_database, route_idea


class CapTrigger(str, Enum):
    """Score cap triggers from the v0.1 product spec."""

    UNCLEAR_RELATED_WORK_DIFFERENCE = "unclear_related_work_difference"
    MISSING_VERIFIABLE_EXPERIMENT_PLAN = "missing_verifiable_experiment_plan"
    ENGINEERING_ONLY = "engineering_only"
    MISSING_STRONG_BASELINE = "missing_strong_baseline"
    MISSING_THREAT_MODEL = "missing_threat_model"
    MISSING_SYSTEM_METRICS = "missing_system_metrics"
    MISSING_AI_ABLATION_OR_GENERALIZATION = "missing_ai_ablation_or_generalization"
    INSUFFICIENT_RECENT_LITERATURE = "insufficient_recent_literature"
    NON_FULL_REGULAR_TARGET = "non_full_regular_target"


CAP_LIMITS: dict[CapTrigger, int] = {
    CapTrigger.UNCLEAR_RELATED_WORK_DIFFERENCE: 60,
    CapTrigger.MISSING_VERIFIABLE_EXPERIMENT_PLAN: 65,
    CapTrigger.ENGINEERING_ONLY: 55,
    CapTrigger.MISSING_STRONG_BASELINE: 70,
    CapTrigger.MISSING_THREAT_MODEL: 60,
    CapTrigger.MISSING_SYSTEM_METRICS: 65,
    CapTrigger.MISSING_AI_ABLATION_OR_GENERALIZATION: 70,
    CapTrigger.INSUFFICIENT_RECENT_LITERATURE: 70,
    CapTrigger.NON_FULL_REGULAR_TARGET: 50,
}


DIMENSION_WEIGHTS: dict[str, int] = {
    "problem_importance": 10,
    "novelty": 20,
    "technical_depth": 15,
    "venue_fit": 10,
    "experimental_verifiability": 15,
    "baseline_dataset_metric": 10,
    "feasibility": 10,
    "engineering_open_source_value": 5,
    "paper_story": 5,
}


@dataclass(frozen=True)
class ScoreBreakdown:
    """A capped CCF-A score with per-dimension evidence."""

    total: int
    uncapped_total: int
    dimensions: dict[str, int]
    cap_triggers: tuple[CapTrigger, ...]
    cap_limit: int | None


@dataclass(frozen=True)
class ParsedIdea:
    """Conservative parsing of a raw research idea."""

    raw_text: str
    problem: str
    motivation: str
    proposed_method: str
    expected_contribution: str
    target_scenario: str
    evidence_terms: tuple[str, ...]


@dataclass(frozen=True)
class Diagnosis:
    """Raw and revised CCF-A diagnosis for one idea."""

    parsed_idea: ParsedIdea
    routes: tuple[DomainRoute, ...]
    raw_score: ScoreBreakdown
    revised_score: ScoreBreakdown
    required_evidence: tuple[str, ...]
    risks: tuple[str, ...]
    revised_plan: tuple[str, ...]
    revised_plan_text: str
    evidence_gate: EvidenceGate
    security_assessment: SecurityAssessment


def parse_idea(idea: str) -> ParsedIdea:
    """Extract a transparent, non-generative skeleton from the idea text."""

    compact = " ".join(idea.split())
    problem = compact or "TODO: define the research problem."
    evidence_terms = _matched_terms(
        compact,
        [
            "benchmark",
            "baseline",
            "dataset",
            "metric",
            "ablation",
            "scalability",
            "latency",
            "throughput",
            "threat model",
            "privacy",
            "security",
            "novel",
            "new",
            "compare",
            "evaluation",
            "experiment",
        ],
    )
    return ParsedIdea(
        raw_text=idea,
        problem=problem,
        motivation=_sentence_or_todo(
            compact,
            ["because", "motivat", "need", "problem", "bottleneck"],
            "TODO: explain why the target community should care.",
        ),
        proposed_method=_sentence_or_todo(
            compact,
            ["method", "approach", "system", "model", "algorithm", "framework"],
            "TODO: describe the proposed method or system.",
        ),
        expected_contribution=_sentence_or_todo(
            compact,
            ["contribution", "novel", "new", "improve", "reduce", "detect"],
            "TODO: state the expected scientific contribution.",
        ),
        target_scenario=_sentence_or_todo(
            compact,
            ["agent", "security", "system", "runtime", "llm", "database"],
            "TODO: identify the concrete target user, workload, or scenario.",
        ),
        evidence_terms=evidence_terms,
    )


def diagnose_idea(
    idea: str,
    *,
    requested_domains: list[str] | None = None,
    database: VenueDatabase | None = None,
    verified_papers: list[PaperRecord] | None = None,
    baselines: list[str] | None = None,
    datasets: list[str] | None = None,
    metrics: list[str] | None = None,
    claim_evidence_rows: list[dict[str, str]] | None = None,
) -> Diagnosis:
    """Produce strict raw and revised CCF-A readiness scores."""

    database = database or load_venue_database()
    security_assessment = assess_security_scope(idea)
    scoped_idea = safe_security_reframe(idea, security_assessment)
    parsed = parse_idea(scoped_idea)
    routes = tuple(route_idea(scoped_idea, database, requested_domains=requested_domains))
    primary = routes[0].domain
    required_evidence = _required_evidence(primary.key)
    revised_plan = _revised_plan(primary.key)
    revised_plan_text = _build_revised_plan_text(
        parsed,
        primary.key,
        required_evidence,
        revised_plan,
    )
    raw = _score(parsed, routes[0])
    revised = _score(parse_idea(revised_plan_text), routes[0])
    evidence_gate = evaluate_evidence_gate(
        verified_papers,
        baselines=baselines,
        datasets=datasets,
        metrics=metrics,
        claim_evidence_rows=claim_evidence_rows,
    )
    risks = _risks_for(primary.key, raw.cap_triggers)
    return Diagnosis(
        parsed_idea=parsed,
        routes=routes,
        raw_score=raw,
        revised_score=revised,
        required_evidence=required_evidence,
        risks=risks,
        revised_plan=revised_plan,
        revised_plan_text=revised_plan_text,
        evidence_gate=evidence_gate,
        security_assessment=security_assessment,
    )


def _score(parsed: ParsedIdea, route: DomainRoute) -> ScoreBreakdown:
    idea = parsed.raw_text.casefold()
    dimensions: dict[str, int] = {}
    dimensions["problem_importance"] = _bounded(4 + route.score // 15 + _has_any(idea, "real", "important", "bottleneck"), 10)
    dimensions["novelty"] = _bounded(5 + _has_any(idea, "novel", "new", "gap", "different") * 4 + route.score // 20, 20)
    dimensions["technical_depth"] = _bounded(4 + _has_any(idea, "algorithm", "system", "theory", "prototype", "method") * 4, 15)
    dimensions["venue_fit"] = _bounded(3 + min(route.score // 10, 7), 10)
    dimensions["experimental_verifiability"] = _bounded(3 + _has_any(idea, "experiment", "evaluation", "benchmark", "metric") * 4, 15)
    dimensions["baseline_dataset_metric"] = _bounded(2 + _has_any(idea, "baseline", "dataset", "metric") * 3, 10)
    dimensions["feasibility"] = _bounded(5 + _has_any(idea, "12 week", "resource", "gpu", "prototype") * 2, 10)
    dimensions["engineering_open_source_value"] = _bounded(2 + _has_any(idea, "repo", "open source", "benchmark", "tool") * 2, 5)
    dimensions["paper_story"] = _bounded(3 + _has_any(idea, "claim", "contribution", "story") * 2, 5)

    triggers = _cap_triggers(idea, route.domain.key)
    uncapped = sum(dimensions.values())
    cap_limit = min((CAP_LIMITS[trigger] for trigger in triggers), default=None)
    total = min(uncapped, cap_limit) if cap_limit is not None else uncapped
    return ScoreBreakdown(
        total=total,
        uncapped_total=uncapped,
        dimensions=dimensions,
        cap_triggers=triggers,
        cap_limit=cap_limit,
    )


def _cap_triggers(idea: str, domain: str) -> tuple[CapTrigger, ...]:
    triggers: list[CapTrigger] = []
    if not _has_any(idea, "related work", "prior work", "different", "novel", "gap"):
        triggers.append(CapTrigger.UNCLEAR_RELATED_WORK_DIFFERENCE)
    if not _has_any(idea, "experiment", "evaluation", "benchmark", "metric", "dataset"):
        triggers.append(CapTrigger.MISSING_VERIFIABLE_EXPERIMENT_PLAN)
    if _has_any(idea, "platform", "tool", "repo", "dashboard") and not _has_any(
        idea, "hypothesis", "claim", "novel", "new"
    ):
        triggers.append(CapTrigger.ENGINEERING_ONLY)
    if not _has_any(idea, "baseline", "sota", "compare", "comparison"):
        triggers.append(CapTrigger.MISSING_STRONG_BASELINE)
    if domain == "security" and not _has_any(idea, "threat model", "attacker", "defender"):
        triggers.append(CapTrigger.MISSING_THREAT_MODEL)
    if domain == "systems" and not _has_any(
        idea, "latency", "throughput", "memory", "scalability", "cost"
    ):
        triggers.append(CapTrigger.MISSING_SYSTEM_METRICS)
    if domain == "ai_llm_agent" and not _has_any(
        idea, "ablation", "generalization", "ood", "failure case"
    ):
        triggers.append(CapTrigger.MISSING_AI_ABLATION_OR_GENERALIZATION)
    if not _has_any(idea, "2024", "2025", "2026", "recent", "last two years"):
        triggers.append(CapTrigger.INSUFFICIENT_RECENT_LITERATURE)
    if _has_any(
        idea,
        "workshop",
        "short paper",
        "short-paper",
        "short submission",
        "demo paper",
        "demo track",
        "demo submission",
    ):
        triggers.append(CapTrigger.NON_FULL_REGULAR_TARGET)

    return tuple(triggers)


def _required_evidence(domain: str) -> tuple[str, ...]:
    common = (
        "A traceable related-work matrix with real papers, links, and BibTeX.",
        "A strong-baseline list with datasets, metrics, and reproduction order.",
        "A claim-evidence matrix that maps every paper claim to planned evidence.",
    )
    if domain == "security":
        return common + (
            "A threat model with attacker and defender capabilities plus ethical boundaries.",
        )
    if domain == "systems":
        return common + (
            "End-to-end and microbenchmark metrics for throughput, latency, memory, scalability, and cost.",
        )
    return common + (
        "Ablation, generalization, and failure-case analysis for the proposed agent method.",
    )


def _risks_for(domain: str, triggers: tuple[CapTrigger, ...]) -> tuple[str, ...]:
    risks = [
        "Novelty may collapse if recent related work already covers the same problem.",
        "The submission will be weak without reproducible baselines and grounded citations.",
    ]
    if CapTrigger.NON_FULL_REGULAR_TARGET in triggers:
        risks.append("CCF-A readiness should be judged against Full or Regular papers, not workshop, demo, or short-paper tracks.")
    if CapTrigger.MISSING_VERIFIABLE_EXPERIMENT_PLAN in triggers:
        risks.append("The current idea lacks enough experimental detail to support CCF-A claims.")
    if domain == "security":
        risks.append("Security work needs clear defensive framing and cannot rely on attack demos alone.")
    if domain == "systems":
        risks.append("Systems work needs a real bottleneck, a prototype, and measured system impact.")
    if domain == "ai_llm_agent":
        risks.append("AI/agent work risks being seen as prompt engineering without ablations and strong benchmarks.")
    return tuple(risks)


def _revised_plan(domain: str) -> tuple[str, ...]:
    base = [
        "Freeze a precise problem statement and define the target claim before implementation.",
        "Build a related-work map from real sources; mark collision risk for each paper.",
        "Select strong baselines, datasets, metrics, and a reproduction-first experiment order.",
        "Create a 12-week execution plan with weekly deliverables and fallback paths.",
    ]
    if domain == "security":
        base.insert(1, "Write the threat model, allowed scope, and responsible disclosure notes first.")
    elif domain == "systems":
        base.insert(1, "Identify the system bottleneck and prototype the smallest measurable design change.")
    else:
        base.insert(1, "Define the agent-specific benchmark, ablations, generalization checks, and failure cases.")
    return tuple(base)


def _build_revised_plan_text(
    parsed: ParsedIdea,
    domain: str,
    required_evidence: tuple[str, ...],
    revised_plan: tuple[str, ...],
) -> str:
    """Build the explicit plan that receives the revised score."""

    common = [
        f"Research idea: {parsed.problem}",
        "Novel research gap: define how this work differs from prior work and recent 2024 2025 2026 related work.",
        "Hypothesis and claim: state a falsifiable claim before implementation.",
        "Experiment evaluation plan: benchmark, dataset, metric, baseline, SOTA comparison, and reproduction order.",
        "Open source repo: maintain configs, scripts, logs, and a claim evidence matrix.",
        "Paper story: connect problem, method, evidence, limitations, and release plan.",
    ]
    if domain == "security":
        common.extend(
            [
                "Threat model: specify attacker capability, defender capability, scope limits, ethics, and responsible disclosure.",
                "Security evaluation: report false positive, false negative, robustness, and defensive utility metrics.",
            ]
        )
    elif domain == "systems":
        common.extend(
            [
                "System prototype: measure latency, throughput, memory, scalability, and cost against systems baselines.",
                "Systems experiments: include end-to-end evaluation, microbenchmarks, ablation, and failure cases.",
            ]
        )
    else:
        common.extend(
            [
                "AI agent evaluation: include ablation, generalization, OOD, and failure case analysis.",
                "Agent baselines: compare against long-context, RAG, memory summarization, planning, and tool-use baselines.",
            ]
        )
    common.extend(required_evidence)
    common.extend(revised_plan)
    return " ".join(common)


def _matched_terms(text: str, terms: list[str]) -> tuple[str, ...]:
    normalized = text.casefold()
    return tuple(term for term in terms if term in normalized)


def _sentence_or_todo(text: str, needles: list[str], fallback: str) -> str:
    for sentence in re.split(r"(?<=[.!?。！？])\s+", text):
        lowered = sentence.casefold()
        if any(needle in lowered for needle in needles):
            return sentence
    return fallback


def _has_any(text: str, *needles: str) -> int:
    return int(any(needle in text for needle in needles))


def _bounded(value: int, upper: int) -> int:
    return max(0, min(value, upper))
