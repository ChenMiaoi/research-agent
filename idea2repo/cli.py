"""Command line entry point for Idea2Repo."""

from __future__ import annotations

import argparse
import sys

from .generator import generate_research_repo


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
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = generate_research_repo(
            args.idea,
            args.output,
            requested_domains=args.domains,
            force=args.force,
        )
    except (FileExistsError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    diagnosis = result.diagnosis
    print(f"Generated Idea2Repo project: {result.root}")
    print(f"Primary route: {diagnosis.routes[0].domain.label}")
    print(f"Raw Idea Score: {diagnosis.raw_score.total} / 100")
    print(f"Revised Plan Score: {diagnosis.revised_score.total} / 100")
    print("Main report: docs/diagnosis/ccf_a_readiness_report.md")
    return 0
