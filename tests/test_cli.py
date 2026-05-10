import unittest
import tempfile
from pathlib import Path

from idea2repo.cli import build_parser, main


class CliTests(unittest.TestCase):
    def test_parser_accepts_idea_and_output(self) -> None:
        args = build_parser().parse_args(["test idea", "--output", "out", "--domain", "OSDI"])
        self.assertEqual(args.idea, "test idea")
        self.assertEqual(args.output, "out")
        self.assertEqual(args.domains, ["OSDI"])

    def test_main_returns_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out"
            self.assertEqual(main(["test idea", "--output", str(output), "--domain", "systems"]), 0)
            self.assertTrue((output / "docs/diagnosis/ccf_a_readiness_report.md").exists())

    def test_main_returns_error_for_non_empty_output_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "out"
            output.mkdir()
            (output / "README.md").write_text("user content")
            self.assertEqual(main(["test idea", "--output", str(output)]), 2)


if __name__ == "__main__":
    unittest.main()
