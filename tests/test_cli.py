import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from idea2repo.cli import build_command_parser, build_parser, main


class CliTests(unittest.TestCase):
    def test_parser_accepts_idea_and_output(self) -> None:
        args = build_parser().parse_args(
            [
                "test idea",
                "--output",
                "out",
                "--domain",
                "OSDI",
                "--weeks",
                "16",
                "--resource",
                "no-gpu",
                "--stack",
                "ts",
            ]
        )
        self.assertEqual(args.idea, "test idea")
        self.assertEqual(args.output, "out")
        self.assertEqual(args.domains, ["OSDI"])
        self.assertEqual(args.weeks, 16)
        self.assertEqual(args.resources, ["no-gpu"])
        self.assertEqual(args.stack, "ts")

    def test_command_parser_accepts_generate_subcommand(self) -> None:
        args = build_command_parser().parse_args(
            [
                "generate",
                "test idea",
                "--output",
                "out",
                "--allow-network",
            ]
        )
        self.assertEqual(args.command, "generate")
        self.assertEqual(args.idea, "test idea")
        self.assertEqual(args.output, "out")
        self.assertTrue(args.allow_network)

    def test_main_returns_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out"
            self.assertEqual(
                main(
                    [
                        "test idea",
                        "--output",
                        str(output),
                        "--domain",
                        "systems",
                        "--weeks",
                        "8",
                        "--resource",
                        "single-researcher",
                    ]
                ),
                0,
            )
            self.assertTrue((output / "docs/diagnosis/ccf_a_readiness_report.md").exists())
            self.assertTrue((output / "docs/execution_plan/8_week_plan.md").exists())

    def test_subcommands_status_validate_and_resume(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out"
            self.assertEqual(main(["generate", "test idea", "--output", str(output)]), 0)
            self.assertEqual(main(["status", "--output", str(output)]), 0)
            self.assertEqual(main(["validate", "--output", str(output)]), 0)
            (output / "docs/survey/survey.md").unlink()
            self.assertEqual(main(["validate", "--output", str(output)]), 1)
            self.assertEqual(main(["resume", "--output", str(output)]), 0)
            self.assertTrue((output / "docs/survey/survey.md").exists())

    def test_doctor_returns_success(self) -> None:
        self.assertEqual(main(["doctor", "--cwd", "."]), 0)

    def test_provider_validate_respects_environment(self) -> None:
        with patch.dict("os.environ", {"IDEA2REPO_PROVIDER": "openai_api_key"}, clear=True):
            self.assertEqual(main(["provider", "validate"]), 1)
        with patch.dict(
            "os.environ",
            {"IDEA2REPO_PROVIDER": "openai_api_key", "OPENAI_API_KEY": "sk-test-secret"},
            clear=True,
        ):
            self.assertEqual(main(["provider", "validate"]), 0)

    def test_venues_validate_returns_success(self) -> None:
        self.assertEqual(main(["venues", "validate"]), 0)

    def test_github_dry_run_returns_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "github-cli"
            self.assertEqual(main(["generate", "test idea", "--output", str(output)]), 0)
            self.assertEqual(
                main(["github", "dry-run", "--output", str(output), "--repo-name", "demo repo"]),
                0,
            )

    def test_github_publish_is_denied_without_permission(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "github-publish"
            self.assertEqual(main(["generate", "test idea", "--output", str(output)]), 0)
            self.assertEqual(main(["github", "publish", "--output", str(output)]), 2)

    def test_main_returns_error_for_non_empty_output_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out"
            output.mkdir()
            (output / "README.md").write_text("user content")
            self.assertEqual(main(["test idea", "--output", str(output)]), 2)


if __name__ == "__main__":
    unittest.main()
