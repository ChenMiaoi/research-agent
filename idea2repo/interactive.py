"""Codex-style interactive CLI session for Idea2Repo."""

from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TextIO

from .auth import AuthError, AuthProvider
from .codex_agent import CodexAgentError, CodexCliClient, DerivedResearchConfig, IdeaDiscussionTurn
from .codex_models import CodexModelCatalog, load_codex_model_catalog
from .codex_oauth import OAUTH_CODEX_PROVIDER_ID, CodexOAuthClient
from .codex_agent import CODEX_PROVIDER_ID
from .generator import GeneratedProject, generate_research_repo, resume_research_repo, slugify
from .permissions import PermissionPolicy
from .state import status as project_status
from .state import validate as validate_project


InputFunc = Callable[[str], str]
OutputFunc = Callable[[str], None]
GenerateFunc = Callable[..., GeneratedProject]


@dataclass
class InteractiveSettings:
    """Mutable interactive session settings."""

    output: Path | None = None
    model: str = ""
    reasoning_effort: str = ""


class InteractiveSession:
    """Small slash-command composer inspired by Codex and Claude Code."""

    def __init__(
        self,
        *,
        codex_client: CodexCliClient | None = None,
        auth_provider: AuthProvider | None = None,
        input_func: InputFunc | None = None,
        output_func: OutputFunc | None = None,
        generate_func: GenerateFunc = generate_research_repo,
        model_catalog: CodexModelCatalog | None = None,
        stdout: TextIO | None = None,
    ) -> None:
        self.codex_client = codex_client
        self.auth_provider = auth_provider or AuthProvider()
        self.input_func = input_func
        if output_func is not None:
            self.output = output_func
        elif stdout is not None:
            self.output = lambda message: print(message, file=stdout)
        else:
            self.output = print
        self.generate_func = generate_func
        self.model_catalog = model_catalog or load_codex_model_catalog()
        self.settings = InteractiveSettings()
        default_model = self.model_catalog.default_model()
        self.settings.model = default_model.slug
        self.settings.reasoning_effort = default_model.default_reasoning
        self.last_output: Path | None = None

    def run(self) -> int:
        self.output("Idea2Repo")
        if not self._ensure_login():
            return 1
        self.output("Enter a research idea. Codex will ask only necessary follow-up questions.")
        while True:
            try:
                raw = self._read("Research idea > ").strip()
            except (EOFError, KeyboardInterrupt):
                self.output("")
                return 0
            if not raw:
                continue
            if raw.startswith("/"):
                result = self._handle_command(raw)
                if result == "exit":
                    return 0
                continue
            self._generate_from_idea(raw)

    def _ensure_login(self) -> bool:
        if self.codex_client is not None:
            return self._ensure_cli_login()
        session = self.auth_provider.current_session()
        self.output(f"Auth: {self.auth_provider.status_text()}")
        if session.is_authenticated and not session.is_expired and session.mode == "openai_account":
            return True
        self.output("Idea2Repo OAuth login is required before starting a research session.")
        answer = self._read("Run Idea2Repo OAuth login now? [Y/n] > ").strip().lower()
        if answer in {"n", "no", "/exit", "exit", "quit"}:
            return False
        try:
            self.auth_provider.login_with_browser(
                open_browser=True,
                manual_input_func=self._read,
                on_auth=lambda pending: self.output(f"Open this URL to sign in: {pending.authorization_url}"),
            )
        except AuthError as exc:
            self.output(f"error: {exc}")
            return False
        session = self.auth_provider.current_session()
        if not (session.is_authenticated and not session.is_expired):
            self.output(f"error: {self.auth_provider.status_text()}")
            return False
        return True

    def _ensure_cli_login(self) -> bool:
        assert self.codex_client is not None
        status = self.codex_client.check_login()
        self.output(f"Codex: {status.status_text}")
        if status.available and status.logged_in:
            return True
        self.output("Codex login is required before starting a research session.")
        answer = self._read("Run `codex login` now? [Y/n] > ").strip().lower()
        if answer in {"n", "no", "/exit", "exit", "quit"}:
            return False
        try:
            self.codex_client.login()
        except CodexAgentError as exc:
            self.output(f"error: {exc}")
            return False
        status = self.codex_client.check_login()
        if not status.logged_in:
            self.output(f"error: {status.status_text}")
            return False
        return True

    def _handle_command(self, raw: str) -> str | None:
        parts = shlex.split(raw)
        command = parts[0]
        args = parts[1:]
        try:
            if command in {"/exit", "/quit"}:
                return "exit"
            if command == "/help":
                self._print_help()
            elif command == "/logout":
                if self.codex_client is not None:
                    self.codex_client.logout()
                else:
                    self.auth_provider.logout()
                self.output("Logged out")
            elif command == "/status":
                self._print_status(args)
            elif command == "/model":
                self._set_model(args)
            elif command == "/reasoning":
                self._set_reasoning(args)
            else:
                self.output(f"Unknown command: {command}")
        except (AuthError, CodexAgentError, ValueError, FileNotFoundError, PermissionError) as exc:
            self.output(f"error: {exc}")
        return None

    def _generate_from_idea(self, idea: str) -> None:
        turn = self._run_discussion_loop(idea)
        if turn is None:
            return
        config = _valid_config(turn.derived_config)
        output = Path("generated_repos") / slugify(config.output_slug)
        self.settings.output = output
        force = False
        if output.exists() and any(output.iterdir()):
            answer = self._read(
                f"Output exists and is not empty: {output}. Overwrite? [y/N] "
            ).strip().lower()
            if answer not in {"y", "yes"}:
                self.output("Generation cancelled. Enter a different output directory on the next run.")
                return
            force = True
        self.output("Starting Codex research analysis...")
        try:
            kwargs = {
                "requested_domains": config.requested_domains or None,
                "timeline_weeks": config.timeline_weeks,
                "resources": config.resources,
                "force": force,
                "stack": config.stack,
                "permission_policy": PermissionPolicy(allow_overwrite=force),
                "provider": CODEX_PROVIDER_ID if self.codex_client is not None else OAUTH_CODEX_PROVIDER_ID,
                "codex_model": self.settings.model,
                "reasoning_effort": self.settings.reasoning_effort,
                "derived_config": config.model_dump(),
                "discussion_assumptions": turn.assumptions,
                "progress_callback": self.output,
            }
            if self.codex_client is not None:
                kwargs["codex_client"] = self.codex_client
            result = self.generate_func(idea, output, **kwargs)
        except (CodexAgentError, AuthError, ValueError, FileNotFoundError, PermissionError) as exc:
            self.output(f"error: {exc}")
            self.output("Generation stopped; no offline fallback was used. Pass --offline for deterministic fallback.")
            return
        self.last_output = result.root
        diagnosis = result.diagnosis
        self.output(f"Generated Idea2Repo project: {result.root}")
        self.output(f"Primary route: {diagnosis.routes[0].domain.label}")
        self.output(f"Raw Idea Score: {diagnosis.raw_score.total} / 100")
        self.output(f"Revised Plan Score: {diagnosis.revised_score.total} / 100")
        self.output(f"Provider: {result.provider_id}")
        self.output(f"Analysis source: {result.analysis_source}")
        self.output(f"Main report: {result.root / 'docs/diagnosis/ccf_a_readiness_report.md'}")

    def _run_discussion_loop(self, idea: str) -> IdeaDiscussionTurn | None:
        conversation: list[dict[str, str]] = []
        while True:
            try:
                client = self._discussion_client()
                result = client.discuss_idea(
                    idea,
                    conversation=conversation,
                    progress_callback=self.output,
                )
            except TypeError:
                result = self.codex_client.discuss_idea(  # type: ignore[union-attr]
                    idea,
                    conversation=conversation,
                )
            except (CodexAgentError, AuthError, ValueError) as exc:
                self.output(f"error: {exc}")
                return None
            turn = result.turn
            self.output(turn.assistant_message)
            if turn.ready_to_analyze:
                return turn
            try:
                reply = self._read("Codex > ").strip()
            except (EOFError, KeyboardInterrupt):
                self.output("")
                return None
            if not reply:
                continue
            if reply.startswith("/"):
                command_result = self._handle_command(reply)
                if command_result == "exit":
                    return None
                continue
            conversation.append({"role": "assistant", "content": turn.assistant_message})
            conversation.append({"role": "user", "content": reply})

    def _discussion_client(self):
        if self.codex_client is not None:
            return self.codex_client
        return CodexOAuthClient(
            auth_provider=self.auth_provider,
            model=self.settings.model,
            reasoning_effort=self.settings.reasoning_effort,
        )

    def _print_status(self, args: list[str]) -> None:
        if self.codex_client is not None:
            codex_status = self.codex_client.check_login()
            self.output(f"Codex: {codex_status.status_text}")
        else:
            self.output(f"Auth: {self.auth_provider.status_text()}")
        self.output(f"Model: {self.settings.model}")
        self.output(f"Reasoning: {self.settings.reasoning_effort}")
        output = Path(args[0]) if args else self.last_output or self.settings.output
        if output is None:
            self.output("No project selected. Generate an idea first.")
            return
        current = project_status(output)
        self.output(f"Project: {current.project_name}")
        self.output(f"Stage: {current.stage}")
        self.output(f"Artifacts: {current.present_artifacts}/{current.total_artifacts} present")
        self.output(f"Missing: {len(current.missing_artifacts)}")
        self.output(f"Modified: {len(current.modified_artifacts)}")

    def _print_settings(self) -> None:
        output = self.settings.output.as_posix() if self.settings.output else "auto"
        self.output(f"Output: {output}")
        self.output(f"Model: {self.settings.model}")
        self.output(f"Reasoning: {self.settings.reasoning_effort}")

    def _set_output(self, args: list[str]) -> None:
        if not args:
            self.output(f"Output: {self.settings.output or 'auto'}")
            return
        self.settings.output = Path(args[0]).expanduser()
        self.output(f"Output set to {self.settings.output}")

    def _set_model(self, args: list[str]) -> None:
        if not args:
            self.output(f"Model: {self.settings.model}")
            return
        if args[0] == "list":
            self.output(f"Model catalog: {self.model_catalog.source}")
            for model in self.model_catalog.models:
                marker = "*" if model.slug == self.settings.model else " "
                self.output(f"{marker} {model.slug} - {model.display_name}")
            return
        model = self.model_catalog.validate_model(args[0])
        self.settings.model = model.slug
        if not model.supports_reasoning(self.settings.reasoning_effort):
            self.settings.reasoning_effort = model.default_reasoning
        self.output(f"Model set to {self.settings.model}")

    def _set_reasoning(self, args: list[str]) -> None:
        levels = self.model_catalog.supported_reasoning(self.settings.model)
        if not args:
            self.output(f"Reasoning: {self.settings.reasoning_effort}")
            return
        if args[0] == "list":
            self.output(f"Reasoning levels for {self.settings.model}:")
            for level in levels:
                marker = "*" if level.effort == self.settings.reasoning_effort else " "
                detail = f" - {level.description}" if level.description else ""
                self.output(f"{marker} {level.effort}{detail}")
            return
        self.model_catalog.validate_reasoning(self.settings.model, args[0])
        self.settings.reasoning_effort = args[0]
        self.output(f"Reasoning set to {self.settings.reasoning_effort}")

    def _validate(self, args: list[str]) -> None:
        output = Path(args[0]) if args else self.last_output or self.settings.output
        if output is None:
            self.output("No project selected. Generate an idea first.")
            return
        errors = validate_project(output)
        if errors:
            for error in errors:
                self.output(error)
            return
        self.output("Validation passed")

    def _resume(self, args: list[str]) -> None:
        output = Path(args[0]) if args else self.last_output or self.settings.output
        if output is None:
            self.output("No project selected. Generate an idea first.")
            return
        result = resume_research_repo(output)
        self.last_output = result.root
        self.output(f"Resumed Idea2Repo project: {result.root}")
        self.output(f"Restored files: {len(result.files)}")

    def _print_help(self) -> None:
        self.output(
            "\n".join(
                [
                    "Commands:",
                    "  /status [path]     show Codex and project status",
                    "  /model [list|slug] show or set the Codex model",
                    "  /reasoning [list|level] show or set reasoning effort",
                    "  /logout            clear Idea2Repo OAuth login",
                    "  /exit              quit",
                ]
            )
        )

    def _read(self, prompt: str) -> str:
        if self.input_func is not None:
            return self.input_func(prompt)
        try:
            from prompt_toolkit import PromptSession
        except Exception:
            return input(prompt)
        return PromptSession().prompt(prompt)


def run_interactive_session() -> int:
    return InteractiveSession().run()


def _valid_config(config: DerivedResearchConfig) -> DerivedResearchConfig:
    weeks = config.timeline_weeks if config.timeline_weeks in {8, 12, 16, 24} else 12
    stack = config.stack if config.stack in {"python", "ts"} else "python"
    output_slug = slugify(config.output_slug)
    return config.model_copy(
        update={
            "timeline_weeks": weeks,
            "stack": stack,
            "output_slug": output_slug,
        }
    )
