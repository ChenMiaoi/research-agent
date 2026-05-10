import unittest
import re

from idea2repo.scoring import diagnose_idea
from idea2repo.workflow import run_workflow, skill_registry, workflow_summary


class WorkflowTests(unittest.TestCase):
    def test_registry_exposes_stable_artifacts(self) -> None:
        registry = skill_registry()
        self.assertEqual(
            {name: skill.artifact for name, skill in registry.items()},
            {
                "venue_router": "docs/workflow/venue_routing.md",
                "literature_radar": "docs/workflow/literature_radar.md",
                "novelty_checker": "docs/workflow/novelty_check.md",
                "scorecard_generator": "docs/workflow/scorecard.md",
                "experiment_designer": "docs/workflow/experiment_design.md",
                "reviewer_simulator": "docs/workflow/reviewer_simulation.md",
                "paper_template_generator": "docs/workflow/paper_skeleton.md",
                "rebuttal_assistant": "docs/workflow/rebuttal_plan.md",
                "weekly_project_manager": "docs/workflow/weekly_management.md",
            },
        )

    def test_workflow_outputs_expected_artifacts_without_result_claims(self) -> None:
        diagnosis = diagnose_idea("agent memory compression", requested_domains=["ai"])
        artifacts = run_workflow(diagnosis)
        expected = {
            "docs/workflow/venue_routing.md",
            "docs/workflow/literature_radar.md",
            "docs/workflow/novelty_check.md",
            "docs/workflow/scorecard.md",
            "docs/workflow/experiment_design.md",
            "docs/workflow/reviewer_simulation.md",
            "docs/workflow/paper_skeleton.md",
            "docs/workflow/rebuttal_plan.md",
            "docs/workflow/weekly_management.md",
        }
        self.assertEqual(set(artifacts), expected)
        for path, content in artifacts.items():
            self.assert_no_result_claims(content.lower(), path)

    def test_workflow_summary_lists_contracts(self) -> None:
        summary = workflow_summary()
        self.assertIn("workflow-first skills", summary)
        self.assertIn("docs/workflow/rebuttal_plan.md", summary)

    def assert_no_result_claims(self, text: str, label: str) -> None:
        forbidden_terms = ("accuracy", "outperform", "outperforms", "sota", "significant")
        for term in forbidden_terms:
            self.assertNotIn(term, text, label)
        forbidden_patterns = (
            r"\b\d+(\.\d+)?\s*%",
            r"\b\d+(\.\d+)?\s*x\b",
            r"\b\d+(\.\d+)?\s*(ms|s|sec|seconds|qps|tokens/s|gb|mb)\b",
            r"\b\d+(\.\d+)?\s*(f1|auc|bleu|rouge|accuracy|latency|throughput)\b",
            r"\b(achieve|achieves|achieved|reduce|reduces|reduced|beat|beats|beating|win|wins|faster|slower|lower|higher)\b",
            r"\\cite\s*\{",
            r"@\s*[a-z]+\s*\{",
            r"\bdoi\b",
            r"\barxiv\b",
            r"\bet al\.",
            r"\b(19|20)\d{2}\b",
        )
        for pattern in forbidden_patterns:
            self.assertIsNone(re.search(pattern, text), f"{label}: {pattern}")


if __name__ == "__main__":
    unittest.main()
