"""Command line entry point for Idea2Repo."""

from __future__ import annotations

import argparse
import sys

from .generator import generate_research_repo, resume_research_repo
from .github_export import build_github_export_plan, publish_with_gh
from .permissions import PermissionDeniedError, PermissionPolicy
from .providers import load_provider_config, safe_provider_report, validate_provider_config
from .state import status as project_status
from .state import validate as validate_project
from .venues import load_venue_database, validate_venue_database
from .workspace import inspect_workspace


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="idea2repo",
        description="Generate a CCF-A readiness repository from a research idea.",
    )
    parser.add_argument("idea", help="Raw research idea text.")
    parser.add_argument(
        "--output",
        default="generated_repos/idea2repo-project",
        help="Directory where the research repository will be generated.",
    )
    parser.add_argument(
        "--domain",
        action="append",
        dest="domains",
        help=(
            "Target domain or venue hint. Can be repeated. Examples: ai, security, "
            "systems, AI/LLM Agent, CCS, OSDI, 安全, 系统."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite files in a non-empty output directory.",
    )
    parser.add_argument(
        "--weeks",
        type=int,
        choices=(8, 12, 16, 24),
        default=12,
        help="Execution timeline in weeks. Use 24 for a six-month plan.",
    )
    parser.add_argument(
        "--resource",
        action="append",
        dest="resources",
        help=(
            "Resource constraint or capability. Can be repeated. Examples: "
            "single-researcher, no-gpu, gpu, real-data, no-real-data."
        ),
    )
    parser.add_argument(
        "--stack",
        choices=("python", "ts"),
        default="python",
        help="Generated research scaffold stack.",
    )
    _add_permission_flags(parser)
    return parser


def build_command_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="idea2repo",
        description="Local-first CCF-A research repository agent.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate", help="Generate a CCF-A readiness repository.")
    legacy = build_parser()
    for action in legacy._actions:
        if action.dest == "help":
            continue
        generate._add_action(action)

    status_parser = subparsers.add_parser("status", help="Show generated project status.")
    status_parser.add_argument("--output", default="generated_repos/idea2repo-project")

    resume = subparsers.add_parser("resume", help="Restore missing generated artifacts without overwriting edits.")
    resume.add_argument("--output", default="generated_repos/idea2repo-project")
    resume.add_argument("--force", action="store_true", help="Allow overwriting generated artifacts.")
    _add_permission_flags(resume)

    validate = subparsers.add_parser("validate", help="Validate generated artifacts against the manifest.")
    validate.add_argument("--output", default="generated_repos/idea2repo-project")

    doctor = subparsers.add_parser("doctor", help="Inspect the current local workspace.")
    doctor.add_argument("--cwd", default=".")

    provider = subparsers.add_parser("provider", help="Inspect provider configuration without exposing secrets.")
    provider.add_argument("action", choices=("validate", "show"))

    venues = subparsers.add_parser("venues", help="Validate or inspect the CCF-A venue database.")
    venues.add_argument("action", choices=("validate",))
    venues.add_argument("--path", help="Optional venue database JSON path.")

    github = subparsers.add_parser("github", help="Preview or publish GitHub export payloads.")
    github.add_argument("action", choices=("dry-run", "publish"))
    github.add_argument("--output", default="generated_repos/idea2repo-project")
    github.add_argument("--repo-name", default="")
    github.add_argument(
        "--no-issues",
        action="store_true",
        help="Skip issue payload generation.",
    )
    _add_permission_flags(github)
    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    command_names = {
        "generate",
        "status",
        "resume",
        "validate",
        "doctor",
        "provider",
        "venues",
        "github",
    }
    parser = build_command_parser() if argv[:1] and argv[0] in command_names else build_parser()
    args = parser.parse_args(argv)
    try:
        command = getattr(args, "command", "generate")
        if command == "generate":
            result = generate_research_repo(
                args.idea,
                args.output,
                requested_domains=args.domains,
                timeline_weeks=args.weeks,
                resources=args.resources,
                force=args.force,
                permission_policy=_policy_from_args(args),
                stack=args.stack,
            )
            _print_generation_result(result, args.weeks)
            return 0
        if command == "status":
            current = project_status(args.output)
            print(f"Project: {current.project_name}")
            print(f"Stage: {current.stage}")
            print(f"Artifacts: {current.present_artifacts}/{current.total_artifacts} present")
            print(f"Missing: {len(current.missing_artifacts)}")
            print(f"Modified: {len(current.modified_artifacts)}")
            return 0
        if command == "resume":
            result = resume_research_repo(
                args.output,
                force=args.force,
                permission_policy=_policy_from_args(args),
            )
            print(f"Resumed Idea2Repo project: {result.root}")
            print(f"Restored files: {len(result.files)}")
            return 0
        if command == "validate":
            errors = validate_project(args.output)
            if errors:
                for error in errors:
                    print(error, file=sys.stderr)
                return 1
            print("Validation passed")
            return 0
        if command == "doctor":
            snapshot = inspect_workspace(args.cwd)
            print(f"cwd: {snapshot.cwd}")
            print(f"git_root: {snapshot.git_root or 'not detected'}")
            print(f"git_branch: {snapshot.git_branch or 'not detected'}")
            print(f"git_status_entries: {len(snapshot.git_status_short)}")
            return 0
        if command == "provider":
            config = load_provider_config()
            if args.action == "show":
                print(safe_provider_report())
                return 0
            errors = validate_provider_config(config)
            if errors:
                for error in errors:
                    print(error, file=sys.stderr)
                return 1
            print("Provider configuration valid")
            return 0
        if command == "venues":
            database = load_venue_database(args.path)
            errors = validate_venue_database(database)
            if errors:
                for error in errors:
                    print(error, file=sys.stderr)
                return 1
            total = sum(len(domain.venue_records) for domain in database.domains.values())
            print(f"Venue database valid: {database.version} ({total} records)")
            return 0
        if command == "github":
            plan = build_github_export_plan(
                args.output,
                repo_name=args.repo_name,
                create_issues=not args.no_issues,
            )
            if args.action == "dry-run":
                print(plan.json(), end="")
                return 0
            result = publish_with_gh(plan, permission_policy=_policy_from_args(args))
            print(result.json(), end="")
            return 0
    except (FileExistsError, ValueError, FileNotFoundError, PermissionDeniedError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"error: unknown command: {getattr(args, 'command', None)}", file=sys.stderr)
    return 2


def _print_generation_result(result, weeks: int) -> None:
    diagnosis = result.diagnosis
    print(f"Generated Idea2Repo project: {result.root}")
    print(f"Primary route: {diagnosis.routes[0].domain.label}")
    print(f"Raw Idea Score: {diagnosis.raw_score.total} / 100")
    print(f"Revised Plan Score: {diagnosis.revised_score.total} / 100")
    print("Main report: docs/diagnosis/ccf_a_readiness_report.md")
    print(f"Execution plan: docs/execution_plan/{weeks}_week_plan.md")


def _add_permission_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--allow-network", action="store_true", help="Permit network operations.")
    parser.add_argument("--allow-login", action="store_true", help="Permit login operations.")
    parser.add_argument("--allow-install", action="store_true", help="Permit dependency installation.")
    parser.add_argument("--allow-publish", action="store_true", help="Permit external publishing.")


def _policy_from_args(args: argparse.Namespace) -> PermissionPolicy:
    return PermissionPolicy(
        allow_overwrite=bool(getattr(args, "force", False)),
        allow_network=bool(getattr(args, "allow_network", False)),
        allow_login=bool(getattr(args, "allow_login", False)),
        allow_install=bool(getattr(args, "allow_install", False)),
        allow_publish=bool(getattr(args, "allow_publish", False)),
    )
