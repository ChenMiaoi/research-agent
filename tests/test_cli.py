import unittest

from idea2repo.cli import build_parser, main


class CliTests(unittest.TestCase):
    def test_parser_accepts_idea_and_output(self) -> None:
        args = build_parser().parse_args(["test idea", "--output", "out"])
        self.assertEqual(args.idea, "test idea")
        self.assertEqual(args.output, "out")

    def test_main_returns_success(self) -> None:
        self.assertEqual(main(["test idea", "--output", "out"]), 0)


if __name__ == "__main__":
    unittest.main()
