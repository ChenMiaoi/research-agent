"""Codex CLI backed research analysis for Idea2Repo."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


CODEX_PROVIDER_ID = "openai-codex-cli"
CODEX_API_SHAPE = "codex-exec-json"
CODEX_SCHEMA_VERSION = 1
DEFAULT_CODEX_TIMEOUT_SECONDS = 900


class CodexAgentError(RuntimeError):
    """Base class for Codex agent failures."""


class CodexNotInstalledError(CodexAgentError):
    """Raised when the Codex CLI cannot be found."""


class CodexNotLoggedInError(CodexAgentError):
    """Raised when Codex CLI is installed but not authenticated."""


class CodexExecutionError(CodexAgentError):
    """Raised when Codex CLI execution fails."""


class CodexSchemaError(CodexAgentError):
    """Raised when Codex output does not match the expected schema."""


class ScoreAssessment(BaseModel):
    """A strict 0-100 research score from Codex."""

    model_config = ConfigDict(extra="forbid")

    total: int = Field(ge=0, le=100)
    rationale: str = Field(min_length=1)
    cap_reasons: list[str] = Field(default_factory=list)


class DomainRouteAnalysis(BaseModel):
    """Codex venue/domain routing."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1)
    label: str = Field(min_length=1)
    candidate_venues: list[str] = Field(default_factory=list)
    rationale: str = Field(min_length=1)


class PaperCluster(BaseModel):
    """A related-work cluster without fabricated citations."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    core_problem: str = Field(min_length=1)
    method_pattern: str = Field(min_length=1)
    representative_papers: list[str] = Field(default_factory=list)
    collision_risk: str = Field(min_length=1)
    verification_queries: list[str] = Field(default_factory=list)


class ExperimentPlan(BaseModel):
    """Experiment design requirements for a CCF-A style project."""

    model_config = ConfigDict(extra="forbid")

    baselines: list[str] = Field(default_factory=list)
    datasets: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)
    ablations: list[str] = Field(default_factory=list)
    failure_cases: list[str] = Field(default_factory=list)
    reproducibility_checks: list[str] = Field(default_factory=list)


class RevisedPlan(BaseModel):
    """Codex revised research plan."""

    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1)
    key_changes: list[str] = Field(default_factory=list)
    evidence_required: list[str] = Field(default_factory=list)
    feasibility: str = Field(min_length=1)


class TimelineItem(BaseModel):
    """One planned timeline item."""

    model_config = ConfigDict(extra="forbid")

    week: str = Field(min_length=1)
    deliverable: str = Field(min_length=1)
    exit_criteria: str = Field(min_length=1)

    @field_validator("week", mode="before")
    @classmethod
    def _coerce_week(cls, value: object) -> object:
        if isinstance(value, int):
            return str(value)
        return value


class DerivedResearchConfig(BaseModel):
    """Codex-derived generation configuration from the discussion pass."""

    model_config = ConfigDict(extra="forbid")

    timeline_weeks: int = Field(default=12)
    resources: list[str] = Field(default_factory=list)
    stack: str = Field(default="python")
    output_slug: str = Field(default="idea2repo-project", min_length=1)
    requested_domains: list[str] = Field(default_factory=list)

    @field_validator("timeline_weeks", mode="before")
    @classmethod
    def _coerce_timeline(cls, value: object) -> object:
        if value in (None, ""):
            return 12
        return value

    @field_validator("stack")
    @classmethod
    def _validate_stack(cls, value: str) -> str:
        return value if value in {"python", "ts"} else "python"


class IdeaDiscussionTurn(BaseModel):
    """Visible Codex intake decision before final research analysis."""

    model_config = ConfigDict(extra="forbid")

    assistant_message: str = Field(min_length=1)
    ready_to_analyze: bool
    missing_information: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    derived_config: DerivedResearchConfig = Field(default_factory=DerivedResearchConfig)


class ResearchAnalysis(BaseModel):
    """Structured Codex output used to generate an Idea2Repo project."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=CODEX_SCHEMA_VERSION)
    idea_summary: str = Field(min_length=1)
    problem_statement: str = Field(min_length=1)
    domain_route: DomainRouteAnalysis
    raw_score: ScoreAssessment
    revised_score: ScoreAssessment
    feasibility: str = Field(min_length=1)
    risks: list[str] = Field(default_factory=list)
    related_work_queries: list[str] = Field(default_factory=list)
    paper_clusters: list[PaperCluster] = Field(default_factory=list)
    novelty_gaps: list[str] = Field(default_factory=list)
    revised_plan: RevisedPlan
    experiment_plan: ExperimentPlan
    timeline: list[TimelineItem] = Field(default_factory=list)
    reviewer_simulation: str = Field(min_length=1)
    artifact_contents: dict[str, str] = Field(default_factory=dict)


@dataclass(frozen=True)
class CodexLoginStatus:
    """Safe-to-print Codex CLI auth status."""

    available: bool
    logged_in: bool
    status_text: str
    binary: str | None = None
    version: str | None = None


@dataclass(frozen=True)
class CodexAnalysisResult:
    """Codex analysis plus non-sensitive execution metadata."""

    analysis: ResearchAnalysis
    provider_id: str
    api_shape: str
    codex_version: str | None
    codex_model: str | None
    stdout_events: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class CodexDiscussionResult:
    """Structured discussion turn plus non-sensitive provider metadata."""

    turn: IdeaDiscussionTurn
    provider_id: str
    api_shape: str
    codex_version: str | None
    codex_model: str | None
    stdout_events: tuple[dict[str, Any], ...]


class CodexCliClient:
    """Thin wrapper around the official Codex CLI."""

    def __init__(
        self,
        *,
        binary: str = "codex",
        cwd: str | Path | None = None,
        model: str | None = None,
        reasoning_effort: str | None = None,
        timeout_seconds: float = DEFAULT_CODEX_TIMEOUT_SECONDS,
    ) -> None:
        self.binary = binary
        self.cwd = Path(cwd or ".").resolve()
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.timeout_seconds = timeout_seconds

    def check_login(self) -> CodexLoginStatus:
        resolved = shutil.which(self.binary)
        if resolved is None:
            return CodexLoginStatus(
                available=False,
                logged_in=False,
                status_text="codex CLI not installed",
            )
        version = self.version()
        try:
            completed = self._run(("login", "status"), timeout_seconds=30, check=False)
        except CodexExecutionError as exc:
            return CodexLoginStatus(
                available=True,
                logged_in=False,
                status_text=str(exc),
                binary=resolved,
                version=version,
            )
        text = _summarize_output(completed.stdout, completed.stderr)
        logged_in = completed.returncode == 0 and "logged in" in text.casefold()
        return CodexLoginStatus(
            available=True,
            logged_in=logged_in,
            status_text=text or ("logged in" if logged_in else "not logged in"),
            binary=resolved,
            version=version,
        )

    def login(self) -> None:
        self.require_installed()
        command = [self.binary, "login"]
        try:
            completed = subprocess.run(
                command,
                cwd=self.cwd,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise CodexExecutionError("Codex login timed out") from exc
        except OSError as exc:
            raise CodexExecutionError(f"failed to run Codex CLI: {exc}") from exc
        if completed.returncode != 0:
            raise CodexExecutionError(
                f"Codex login failed with exit code {completed.returncode}"
            )

    def login_with_api_key(self, api_key: str) -> None:
        self.require_installed()
        if not api_key.strip():
            raise CodexExecutionError("API key must not be empty")
        command = [self.binary, "login", "--with-api-key"]
        try:
            completed = subprocess.run(
                command,
                cwd=self.cwd,
                input=api_key.strip() + "\n",
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise CodexExecutionError("Codex API-key login timed out") from exc
        except OSError as exc:
            raise CodexExecutionError(f"failed to run Codex CLI: {exc}") from exc
        if completed.returncode != 0:
            detail = _summarize_output(completed.stderr, completed.stdout)
            raise CodexExecutionError(
                f"Codex API-key login failed with exit code {completed.returncode}: {detail}"
            )

    def logout(self) -> None:
        self.require_installed()
        self._run(("logout",), timeout_seconds=60, check=True)

    def version(self) -> str | None:
        if shutil.which(self.binary) is None:
            return None
        try:
            completed = self._run(("--version",), timeout_seconds=15, check=False)
        except CodexExecutionError:
            return None
        text = _summarize_output(completed.stdout, completed.stderr)
        return text or None

    def require_installed(self) -> str:
        resolved = shutil.which(self.binary)
        if resolved is None:
            raise CodexNotInstalledError(
                "Codex CLI is not installed or not on PATH. Install it with npm and run `codex login`."
            )
        return resolved

    def require_logged_in(self) -> CodexLoginStatus:
        status = self.check_login()
        if not status.available:
            raise CodexNotInstalledError(status.status_text)
        if not status.logged_in:
            raise CodexNotLoggedInError(
                "Codex CLI is not logged in. Run `codex login` before generating with Codex."
            )
        return status

    def analyze_idea(
        self,
        idea: str,
        *,
        requested_domains: Sequence[str] | None = None,
        timeline_weeks: int = 12,
        resources: Sequence[str] | None = None,
        stack: str = "python",
    ) -> CodexAnalysisResult:
        status = self.require_logged_in()
        prompt = build_research_prompt(
            idea,
            requested_domains=requested_domains,
            timeline_weeks=timeline_weeks,
            resources=resources,
            stack=stack,
        )
        schema = research_analysis_json_schema()
        with tempfile.TemporaryDirectory(prefix="idea2repo-codex-") as tmp:
            tmp_path = Path(tmp)
            schema_path = tmp_path / "research_analysis.schema.json"
            message_path = tmp_path / "last_message.json"
            schema_path.write_text(
                json.dumps(schema, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            args = [
                "exec",
                "--cd",
                str(self.cwd),
                "--sandbox",
                "read-only",
                "--ignore-user-config",
                "--disable",
                "plugins",
                "--output-schema",
                str(schema_path),
                "--output-last-message",
                str(message_path),
                "--json",
            ]
            self._add_model_args(args)
            args.append(prompt)
            completed = self._run(tuple(args), timeout_seconds=self.timeout_seconds, check=True)
            events = tuple(_parse_jsonl_events(completed.stdout))
            payload_text = message_path.read_text(encoding="utf-8") if message_path.exists() else ""
            analysis = parse_research_analysis(payload_text, events=events)
        return CodexAnalysisResult(
            analysis=analysis,
            provider_id=CODEX_PROVIDER_ID,
            api_shape=CODEX_API_SHAPE,
            codex_version=status.version,
            codex_model=self.model,
            stdout_events=events,
        )

    def discuss_idea(
        self,
        idea: str,
        *,
        conversation: Sequence[Mapping[str, str]] = (),
    ) -> CodexDiscussionResult:
        status = self.require_logged_in()
        prompt = build_discussion_prompt(idea, conversation=conversation)
        schema = discussion_json_schema()
        with tempfile.TemporaryDirectory(prefix="idea2repo-codex-discuss-") as tmp:
            tmp_path = Path(tmp)
            schema_path = tmp_path / "idea_discussion.schema.json"
            message_path = tmp_path / "last_message.json"
            schema_path.write_text(
                json.dumps(schema, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            args = [
                "exec",
                "--cd",
                str(self.cwd),
                "--sandbox",
                "read-only",
                "--ignore-user-config",
                "--disable",
                "plugins",
                "--output-schema",
                str(schema_path),
                "--output-last-message",
                str(message_path),
                "--json",
            ]
            self._add_model_args(args)
            args.append(prompt)
            completed = self._run(tuple(args), timeout_seconds=self.timeout_seconds, check=True)
            events = tuple(_parse_jsonl_events(completed.stdout))
            payload_text = message_path.read_text(encoding="utf-8") if message_path.exists() else ""
            turn = parse_discussion_turn(payload_text, events=events)
        return CodexDiscussionResult(
            turn=turn,
            provider_id=CODEX_PROVIDER_ID,
            api_shape=CODEX_API_SHAPE,
            codex_version=status.version,
            codex_model=self.model,
            stdout_events=events,
        )

    def _add_model_args(self, args: list[str]) -> None:
        if self.reasoning_effort:
            args.extend(["-c", f'model_reasoning_effort="{self.reasoning_effort}"'])
        if self.model:
            args.extend(["--model", self.model])

    def _run(
        self,
        args: Sequence[str],
        *,
        timeout_seconds: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        self.require_installed()
        command = [self.binary, *args]
        try:
            completed = subprocess.run(
                command,
                cwd=self.cwd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise CodexExecutionError(
                f"Codex CLI timed out after {timeout_seconds:g}s while running `{_command_label(command)}`"
            ) from exc
        except OSError as exc:
            raise CodexExecutionError(f"failed to run Codex CLI: {exc}") from exc
        if check and completed.returncode != 0:
            detail = _summarize_output(completed.stderr, completed.stdout)
            raise CodexExecutionError(
                f"Codex CLI failed with exit code {completed.returncode}: {detail}"
            )
        return completed


def research_analysis_json_schema() -> dict[str, Any]:
    """Return the JSON schema passed to `codex exec --output-schema`."""

    return ResearchAnalysis.model_json_schema()


def discussion_json_schema() -> dict[str, Any]:
    """Return the JSON schema for Codex intake discussion turns."""

    return IdeaDiscussionTurn.model_json_schema()


def parse_research_analysis(
    payload_text: str,
    *,
    events: Sequence[Mapping[str, Any]] = (),
) -> ResearchAnalysis:
    """Parse and validate Codex output from final message text or JSONL events."""

    candidates: list[Any] = []
    stripped = payload_text.strip()
    if stripped:
        candidates.append(stripped)
    for event in reversed(events):
        candidates.extend(_event_candidates(event))
    errors: list[str] = []
    for candidate in candidates:
        try:
            if isinstance(candidate, str):
                payload = _loads_json_payload(candidate)
            else:
                payload = candidate
            return ResearchAnalysis.model_validate(payload)
        except (json.JSONDecodeError, TypeError, ValidationError, ValueError) as exc:
            errors.append(str(exc))
            continue
    if not candidates:
        raise CodexSchemaError("Codex did not return a structured final message")
    raise CodexSchemaError(f"Codex output did not match ResearchAnalysis schema: {errors[0]}")


def parse_discussion_turn(
    payload_text: str,
    *,
    events: Sequence[Mapping[str, Any]] = (),
) -> IdeaDiscussionTurn:
    candidates: list[Any] = []
    stripped = payload_text.strip()
    if stripped:
        candidates.append(stripped)
    for event in reversed(events):
        candidates.extend(_event_candidates(event))
    errors: list[str] = []
    for candidate in candidates:
        try:
            payload = _loads_json_payload(candidate) if isinstance(candidate, str) else candidate
            return IdeaDiscussionTurn.model_validate(payload)
        except (json.JSONDecodeError, TypeError, ValidationError, ValueError) as exc:
            errors.append(str(exc))
            continue
    if not candidates:
        raise CodexSchemaError("Codex did not return a structured discussion turn")
    raise CodexSchemaError(f"Codex discussion output did not match schema: {errors[0]}")


def build_discussion_prompt(
    idea: str,
    *,
    conversation: Sequence[Mapping[str, str]] = (),
) -> str:
    transcript = "\n".join(
        f"{item.get('role', 'user')}: {item.get('content', '')}" for item in conversation
    ) or "(no follow-up yet)"
    return f"""You are Idea2Repo's Codex-backed research intake agent.

Return only JSON that satisfies the provided schema. Do not wrap it in Markdown.
Do not reveal hidden chain-of-thought. Use assistant_message for concise visible reasoning,
assumptions, and any necessary clarification question.

Your job is to decide whether the research idea has enough information for a full
CCF-A style analysis. Ask at most two necessary questions when the missing information
would materially change the plan. Otherwise, set ready_to_analyze=true and proceed with
reasonable assumptions.

Derive these generation settings yourself:
- timeline_weeks must be one of 8, 12, 16, 24; default to 12 unless the user implies otherwise.
- resources should capture constraints mentioned by the user; use [] if none.
- stack must be python unless TypeScript is clearly better or requested.
- output_slug must be a short lowercase repo directory slug.
- requested_domains should be inferred from the idea, not asked as a fixed form.

Research idea:
{idea}

Conversation so far:
{transcript}
"""


def build_research_prompt(
    idea: str,
    *,
    requested_domains: Sequence[str] | None = None,
    timeline_weeks: int = 12,
    resources: Sequence[str] | None = None,
    stack: str = "python",
) -> str:
    domains = ", ".join(requested_domains or []) or "auto"
    resource_text = ", ".join(resources or []) or "unspecified"
    return f"""You are Idea2Repo's Codex-backed CCF-A research agent.

Return only JSON that satisfies the provided schema. Do not wrap it in Markdown.

Analyze the user's research idea and produce a strict, evidence-aware research plan.
You must not invent papers, citations, BibTeX, venues, datasets, metrics, or experiment
results. If a paper or claim needs verification, put it in related_work_queries,
paper_clusters.verification_queries, or artifact_contents for literature_search_tasks.

Scoring must be strict for CCF-A Full/Regular paper expectations. Include cap reasons
when related work, baselines, datasets, metrics, threat model, system metrics, ablations,
or recent literature are missing.

Research idea:
{idea}

User constraints:
- requested domains: {domains}
- timeline weeks: {timeline_weeks}
- resources: {resource_text}
- preferred scaffold stack: {stack}

Required artifact content keys may include:
- docs/diagnosis/ccf_a_readiness_report.md
- docs/survey/survey.md
- docs/reference/literature_search_tasks.md
- docs/execution_plan/{timeline_weeks}_week_plan.md
- docs/diagnosis/reviewer_simulation.md
"""


def _loads_json_payload(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        if start == -1:
            raise
        decoder = json.JSONDecoder()
        payload, _ = decoder.raw_decode(text[start:])
        return payload


def _event_candidates(event: Mapping[str, Any]) -> list[Any]:
    candidates: list[Any] = []
    for key in ("message", "last_message", "final_message", "content", "output"):
        value = event.get(key)
        if isinstance(value, (str, dict)):
            candidates.append(value)
    item = event.get("item")
    if isinstance(item, Mapping):
        candidates.extend(_event_candidates(item))
    return candidates


def _parse_jsonl_events(stdout: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def _summarize_output(primary: str, secondary: str = "") -> str:
    text = (primary or secondary or "").strip()
    if not text:
        return ""
    text = " ".join(text.split())
    return text[:500]


def _command_label(command: Sequence[str]) -> str:
    return " ".join(command[:3])
