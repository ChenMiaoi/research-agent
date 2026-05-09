"""Command line entry point for Idea2Repo."""

from __future__ import annotations

import argparse


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
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    print(f"Idea2Repo scaffold is ready for: {args.idea}")
    print(f"Output directory: {args.output}")
    return 0
