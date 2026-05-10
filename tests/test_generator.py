import csv
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from idea2repo.generator import generate_research_repo, resume_research_repo, slugify
from idea2repo.permissions import Operation, PermissionDeniedError, PermissionPolicy
from idea2repo.state import status, validate


class GeneratorTests(unittest.TestCase):
    def test_root_gitignore_covers_web_and_local_service_hygiene(self) -> None:
        root_gitignore = Path(__file__).resolve().parents[1] / ".gitignore"
        content = root_gitignore.read_text()
        for ignored in (
            "/.vite/",
            "/.turbo/",
            "/web/.vite/",
            "/web/.turbo/",
            "/.fastapi/",
            "/.uvicorn/",
            "/.cache/",
            "/.web-cache/",
            "/.codex/sessions/",
            "/.codex/auth/",
        ):
            self.assertIn(ignored, content)

    def test_slugify_creates_cross_platform_name(self) -> None:
        self.assertEqual(slugify("LLM Agent: Memory / Compression!"), "llm-agent-memory-compression")
        self.assertEqual(slugify("!!!"), "idea2repo-project")

    def test_generate_research_repo_writes_core_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "llm-memory"
            result = generate_research_repo(
                "A new LLM agent memory compression method with benchmark and baseline",
                output,
                requested_domains=["AI/LLM Agent"],
                timeline_weeks=16,
                resources=["single-researcher", "no-gpu"],
                created_at="2026-05-10",
            )

            required_paths = [
                "README.md",
                ".gitignore",
                ".dockerignore",
                ".env.example",
                "project.yaml",
                "requirements.txt",
                "docs/diagnosis/ccf_a_readiness_report.md",
                "docs/diagnosis/raw_idea_score.md",
                "docs/diagnosis/revised_plan_score.md",
                "docs/diagnosis/risk_register.md",
                "docs/diagnosis/reviewer_simulation.md",
                "docs/survey/survey.md",
                "docs/survey/paper_map.md",
                "docs/survey/topic_clusters.md",
                "docs/survey/trend_analysis.md",
                "docs/survey/open_problems.md",
                "docs/reference/references.bib",
                "docs/reference/related_work_matrix.csv",
                "docs/reference/claim_evidence_matrix.csv",
                "docs/reference/paper_notes/README.md",
                "docs/reference/pdfs/README.md",
                "docs/execution_plan/16_week_plan.md",
                "docs/execution_plan/milestones.md",
                "docs/execution_plan/todo.md",
                "docs/execution_plan/compute_budget.md",
                "docs/execution_plan/experiment_checklist.md",
                "docs/meeting/weekly_update_template.md",
                "docs/meeting/advisor_report.md",
                "docs/runtime/platform_notes.md",
                "docs/runtime/provider_config.md",
                "docs/runtime/workspace_snapshot.md",
                "paper/main.tex",
                "paper/macros.tex",
                "paper/figures/.gitkeep",
                "paper/tables/.gitkeep",
                "paper/sections/00_abstract.tex",
                "paper/sections/01_introduction.tex",
                "paper/sections/02_related_work.tex",
                "paper/sections/03_problem_formulation.tex",
                "paper/sections/04_method.tex",
                "paper/sections/05_experiments.tex",
                "paper/sections/06_discussion.tex",
                "paper/sections/07_conclusion.tex",
                "src/README.md",
                "src/method/README.md",
                "src/baselines/README.md",
                "src/evaluation/README.md",
                "src/utils/README.md",
                "experiments/README.md",
                "experiments/exp_001_baseline_reproduction/.gitkeep",
                "experiments/exp_002_main_result/.gitkeep",
                "experiments/exp_003_ablation/.gitkeep",
                "experiments/exp_004_scalability_or_robustness/.gitkeep",
                "experiments/exp_005_failure_cases/.gitkeep",
                "configs/README.md",
                "data/README.md",
                "data/raw/.gitkeep",
                "data/processed/.gitkeep",
                "results/README.md",
                "results/logs/.gitkeep",
                "results/tables/.gitkeep",
                "results/figures/.gitkeep",
                "scripts/README.md",
                "scripts/run.sh",
                "scripts/run.ps1",
                "docker/Dockerfile",
                "docker/docker-compose.yml",
                ".github/workflows/README.md",
                ".github/ISSUE_TEMPLATE/research_task.md",
                ".idea2repo/manifest.json",
                ".idea2repo/run_log.jsonl",
            ]

            self.assertEqual(result.root, output)
            for required_path in required_paths:
                self.assertTrue((output / required_path).exists(), required_path)

            report = (output / "docs/diagnosis/ccf_a_readiness_report.md").read_text()
            self.assertIn("Raw Idea Score", report)
            self.assertIn("Revised Plan Score", report)
            self.assertIn("Do not write performance claims", (output / "paper/sections/05_experiments.tex").read_text())
            generated_gitignore = (output / ".gitignore").read_text()
            for ignored in (
                ".env",
                "*.token",
                "*.jks",
                "node_modules/",
                ".fastapi/",
                ".uvicorn/",
                ".cache/",
                ".web-cache/",
                "generated_repos/",
                ".idea2repo/",
                "docs/reference/pdfs/*",
                "*.safetensors",
                "*.parquet",
                "*.sqlite",
                "*.har",
                "results/logs/*",
            ):
                self.assertIn(ignored, generated_gitignore)

            dockerignore = (output / ".dockerignore").read_text()
            for ignored in (
                "secrets/",
                "*.token",
                "*.jks",
                ".envrc",
                ".codex/sessions/",
                ".codex/auth/",
                ".fastapi/",
                ".cache/",
                ".web-cache/",
                "data/raw/",
                "results/",
                "models/",
                "node_modules/",
                "*.har",
            ):
                self.assertIn(ignored, dockerignore)

            env_example = (output / ".env.example").read_text()
            self.assertIn("IDEA2REPO_PROVIDER=offline", env_example)
            self.assertIn("OPENAI_API_KEY=", env_example)

            references = (output / "docs/reference/references.bib").read_text()
            self.assertIn("Do not invent", references)
            self.assertNotRegex(references, r"(?i)@\s*[a-z]+\s*\{")

            with (output / "docs/reference/related_work_matrix.csv").open(newline="") as related_file:
                related_rows = list(csv.DictReader(related_file))
            self.assertEqual(len(related_rows), 1)
            self.assertEqual(related_rows[0]["paper_id"], "TODO")
            self.assertEqual(related_rows[0]["title"], "Add only verified papers")
            self.assertEqual(related_rows[0]["collision_risk"], "Unknown until verified")
            self.assertEqual(related_rows[0]["source_url"], "TODO")
            self.assertEqual(related_rows[0]["bibtex_key"], "TODO")
            self.assertEqual(related_rows[0]["authors"], "TODO")
            self.assertEqual(related_rows[0]["main_claim"], "TODO")
            self.assertEqual(related_rows[0]["evidence"], "TODO")
            self.assertEqual(related_rows[0]["datasets"], "TODO")
            self.assertEqual(related_rows[0]["baselines"], "TODO")
            self.assertEqual(related_rows[0]["metrics"], "TODO")
            self.assertEqual(related_rows[0]["limitations"], "TODO")
            self.assertEqual(related_rows[0]["relation_to_current_idea"], "TODO")
            self.assertEqual(related_rows[0]["useful_for"], "TODO")
            self.assertEqual(related_rows[0]["bibtex"], "TODO")
            self.assertFalse(related_rows[0]["year"].isdigit())

            forbidden_result_terms = (
                "accuracy",
                "outperform",
                "outperforms",
                "improve",
                "improves",
                "sota",
                "significant",
                "p-value",
            )
            for row in related_rows:
                for value in row.values():
                    self.assert_no_result_claims(value.lower(), forbidden_result_terms)

            with (output / "docs/reference/claim_evidence_matrix.csv").open(newline="") as claim_file:
                claim_rows = list(csv.DictReader(claim_file))
            self.assertTrue(claim_rows)
            for row in claim_rows:
                self.assertEqual(row["status"], "planned")
                self.assertTrue(row["claim"].startswith("TODO:"))
                self.assertTrue(row["required_evidence"].startswith("TODO:"))
                result_text = " ".join(row.values()).lower()
                self.assert_no_result_claims(result_text, forbidden_result_terms)

            experiments_tex = (output / "paper/sections/05_experiments.tex").read_text().lower()
            self.assert_no_result_claims(experiments_tex, forbidden_result_terms)

            project_yaml = (output / "project.yaml").read_text()
            self.assertIn("created_at: 2026-05-10", project_yaml)
            self.assertIn("timeline_weeks: 16", project_yaml)
            self.assertIn("single-researcher", project_yaml)
            self.assertIn("no-gpu", project_yaml)
            self.assertIn("raw_idea_score", project_yaml)
            self.assertIn("revised_plan_score", project_yaml)
            self.assertIn("openai_account_login", project_yaml)
            self.assertIn("enterprise_account", project_yaml)
            self.assertIn("local_model", project_yaml)
            self.assertIn("windows", project_yaml)
            self.assertIn("linux", project_yaml)
            self.assertIn("macos", project_yaml)

            plan = (output / "docs/execution_plan/16_week_plan.md").read_text()
            self.assertIn("# 16 Week Plan", plan)
            self.assertIn("single-researcher, no-gpu", plan)

            manifest = (output / ".idea2repo/manifest.json").read_text()
            self.assertIn('"project_name": "llm-memory"', manifest)
            self.assertIn('"permissions"', manifest)
            self.assertIn('"workspace"', manifest)

            workspace_snapshot = (output / "docs/runtime/workspace_snapshot.md").read_text()
            self.assertIn("# Workspace Snapshot", workspace_snapshot)

            current = status(output)
            self.assertEqual(current.total_artifacts, current.present_artifacts)
            self.assertEqual(validate(output), ())

    def test_resume_restores_missing_files_without_overwriting_user_edits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "resume-test"
            generate_research_repo("agent memory compression", output, created_at="2026-05-10")
            readme = output / "README.md"
            readme.write_text("user edited readme", encoding="utf-8")
            survey = output / "docs/survey/survey.md"
            survey.unlink()

            result = resume_research_repo(output)

            self.assertEqual(readme.read_text(encoding="utf-8"), "user edited readme")
            self.assertTrue(survey.exists())
            self.assertIn(survey, result.files)
            current = status(output)
            self.assertNotIn("docs/survey/survey.md", current.missing_artifacts)
            self.assertIn("README.md", current.modified_artifacts)

    def test_resume_reuses_manifest_state_for_sensitive_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "resume-state"
            generate_research_repo("agent memory compression", output, created_at="2001-01-01")
            for relative_path in ("project.yaml", "docs/runtime/workspace_snapshot.md"):
                (output / relative_path).unlink()

            class FakeWorkspace:
                def as_dict(self) -> dict[str, object]:
                    return {
                        "cwd": "fake-cwd",
                        "git_root": "fake-root",
                        "git_branch": "fake-branch",
                        "git_status_short": ["M fake.py"],
                        "tracked_files": 999,
                    }

            with patch("idea2repo.generator.inspect_workspace", return_value=FakeWorkspace()):
                resume_research_repo(output)

            self.assertEqual(validate(output), ())
            project_yaml = (output / "project.yaml").read_text(encoding="utf-8")
            workspace_snapshot = (output / "docs/runtime/workspace_snapshot.md").read_text(encoding="utf-8")
            self.assertIn("created_at: 2001-01-01", project_yaml)
            self.assertNotIn("fake-cwd", workspace_snapshot)
            self.assertNotIn("fake-branch", workspace_snapshot)

    def test_permission_policy_denies_risky_operations_by_default(self) -> None:
        policy = PermissionPolicy()
        with self.assertRaises(PermissionDeniedError):
            policy.require(Operation.NETWORK)
        with self.assertRaises(PermissionDeniedError):
            policy.require(Operation.OVERWRITE)
        self.assertTrue(policy.allows(Operation.WRITE))

    def test_force_requires_overwrite_permission(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "existing"
            output.mkdir()
            (output / "README.md").write_text("user content")

            with self.assertRaises(PermissionDeniedError):
                generate_research_repo(
                    "test idea",
                    output,
                    force=True,
                    permission_policy=PermissionPolicy(allow_overwrite=False),
                )

    def test_denied_force_resume_does_not_write_run_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "resume-denied"
            generate_research_repo("agent memory compression", output, created_at="2026-05-10")
            run_log = output / ".idea2repo/run_log.jsonl"
            before = run_log.read_text(encoding="utf-8")

            with self.assertRaises(PermissionDeniedError):
                resume_research_repo(
                    output,
                    force=True,
                    permission_policy=PermissionPolicy(allow_overwrite=False),
                )

            self.assertEqual(run_log.read_text(encoding="utf-8"), before)

    def test_generate_research_repo_refuses_non_empty_output_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "existing"
            output.mkdir()
            (output / "README.md").write_text("user content")

            with self.assertRaises(FileExistsError):
                generate_research_repo("test idea", output)

    def test_generate_research_repo_rejects_unsupported_timeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                generate_research_repo("test idea", Path(tmp) / "out", timeline_weeks=10)

    def test_result_guard_rejects_fake_numbers_metrics_and_citations(self) -> None:
        forbidden_terms = ("accuracy", "outperform", "sota", "significant")
        bad_examples = [
            "42",
            "3.14",
            "2x",
            "10 ms",
            "f1",
            "latency",
            "throughput",
            "gb",
            "\\cite{fake2025}",
            "@InProceedings{fake}",
            "doi:10.1234/fake",
            "arXiv 2501.00001",
            "Smith et al.",
            "2025",
            "beats baseline",
        ]
        for example in bad_examples:
            with self.subTest(example=example):
                with self.assertRaises(AssertionError):
                    self.assert_no_result_claims(example.lower(), forbidden_terms)

    def assert_no_result_claims(self, text: str, forbidden_terms: tuple[str, ...]) -> None:
        for term in forbidden_terms:
            self.assertNotIn(term, text)
        forbidden_patterns = (
            r"\b\d+(\.\d+)?\s*%",
            r"\b\d+(\.\d+)?\s*x\b",
            r"\b\d+(\.\d+)?\s*(ms|s|sec|seconds|qps|tokens/s|gb|mb)\b",
            r"\b\d+(\.\d+)?\s*(f1|auc|bleu|rouge|accuracy|latency|throughput)\b",
            r"\b\d+(\.\d+)?\b",
            r"\b(f1|auc|bleu|rouge|accuracy|latency|throughput)\b",
            r"\b(ms|sec|seconds|qps|tokens/s|gb|mb)\b",
            r"\b(achieve|achieves|achieved|reduce|reduces|reduced|beat|beats|beating|win|wins|faster|slower|lower|higher)\b",
            r"\\cite\s*\{",
            r"@\s*[a-z]+\s*\{",
            r"\bdoi\b",
            r"\barxiv\b",
            r"\bet al\.",
            r"\b(19|20)\d{2}\b",
        )
        for pattern in forbidden_patterns:
            self.assertIsNone(re.search(pattern, text), pattern)


if __name__ == "__main__":
    unittest.main()
