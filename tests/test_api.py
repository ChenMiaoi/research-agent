import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from idea2repo.api import create_app
from idea2repo.literature import PaperRecord


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app())

    def test_health_endpoint(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_generate_status_validate_resume_and_artifact_read(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "api project"
            generate = self.client.post(
                "/generate",
                json={
                    "idea": "agent memory benchmark with baseline dataset metric",
                    "output": str(output),
                    "domains": ["ai"],
                    "weeks": 8,
                    "resources": ["single-researcher"],
                    "stack": "python",
                },
            )
            self.assertEqual(generate.status_code, 200, generate.text)
            payload = generate.json()
            self.assertEqual(payload["primary_route"], "ai_llm_agent")
            self.assertEqual(payload["evidence_gate"]["status"], "blocked")

            status = self.client.post("/status", json={"output": str(output)})
            self.assertEqual(status.status_code, 200, status.text)
            self.assertEqual(status.json()["missing_artifacts"], [])

            artifact_list = self.client.post("/artifacts", json={"output": str(output)})
            self.assertEqual(artifact_list.status_code, 200, artifact_list.text)
            artifact_paths = [entry["path"] for entry in artifact_list.json()["artifacts"]]
            self.assertIn("docs/diagnosis/ccf_a_readiness_report.md", artifact_paths)
            self.assertIn("docs", artifact_list.json()["tree"])

            artifact = self.client.post(
                "/artifacts/read",
                json={
                    "output": str(output),
                    "path": "docs/diagnosis/ccf_a_readiness_report.md",
                },
            )
            self.assertEqual(artifact.status_code, 200, artifact.text)
            self.assertIn("CCF-A", artifact.json()["content"])

            traversal = self.client.post(
                "/artifacts/read",
                json={"output": str(output), "path": "../outside.txt"},
            )
            self.assertEqual(traversal.status_code, 400)

            (output / "docs/survey/survey.md").unlink()
            invalid = self.client.post("/validate", json={"output": str(output)})
            self.assertEqual(invalid.status_code, 200, invalid.text)
            self.assertFalse(invalid.json()["ok"])

            resume = self.client.post("/resume", json={"output": str(output)})
            self.assertEqual(resume.status_code, 200, resume.text)
            self.assertIn("docs/survey/survey.md", resume.json()["restored_files"])

            valid = self.client.post("/validate", json={"output": str(output)})
            self.assertEqual(valid.status_code, 200, valid.text)
            self.assertTrue(valid.json()["ok"])

    def test_generate_rejects_overwrite_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "existing"
            output.mkdir()
            (output / "README.md").write_text("user content", encoding="utf-8")
            response = self.client.post(
                "/generate",
                json={"idea": "agent memory", "output": str(output)},
            )
            self.assertEqual(response.status_code, 400)

    def test_literature_search_is_offline_by_default(self) -> None:
        with patch("idea2repo.api.search_literature") as search:
            search.return_value = ([], ["Network disabled. Search manually: agent memory"])
            response = self.client.post(
                "/literature/search",
                json={"query": "agent memory"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        search.assert_called_once_with("agent memory", allow_network=False, limit=10)
        self.assertEqual(response.json()["records"], [])
        self.assertIn("Network disabled", response.json()["tasks"][0])

    def test_literature_search_serializes_verified_records(self) -> None:
        record = PaperRecord(
            paper_id="https://openalex.org/W1",
            title="Verified Agent Paper",
            venue="TestConf",
            year=2026,
            authors=("Ada Lovelace",),
            source_url="https://openalex.org/W1",
            bibtex_key="lovelace2026verified",
            openalex_id="https://openalex.org/W1",
        )
        with patch("idea2repo.api.search_literature") as search:
            search.return_value = ([record], [])
            response = self.client.post(
                "/literature/search",
                json={"query": "agent memory", "allow_network": True, "limit": 1},
            )
        self.assertEqual(response.status_code, 200, response.text)
        search.assert_called_once_with("agent memory", allow_network=True, limit=1)
        self.assertEqual(response.json()["records"][0]["authors"], ["Ada Lovelace"])

    def test_score_reviewer_rebuttal_and_provider_contracts(self) -> None:
        score = self.client.post(
            "/score",
            json={"idea": "agent memory benchmark", "domains": ["ai"]},
        )
        self.assertEqual(score.status_code, 200, score.text)
        self.assertEqual(score.json()["evidence_gate"]["status"], "blocked")
        self.assertIn("required_evidence", score.json())

        reviewer = self.client.post(
            "/reviewer/simulate",
            json={"idea": "agent memory benchmark", "domains": ["ai"]},
        )
        self.assertEqual(reviewer.status_code, 200, reviewer.text)
        self.assertIn("Risk:", reviewer.json()["content"])

        rebuttal = self.client.post(
            "/rebuttal",
            json={
                "idea": "agent memory benchmark",
                "reviews": [
                    "Novelty is unclear versus related work.",
                    "Reproducibility needs artifact and data details.",
                ],
            },
        )
        self.assertEqual(rebuttal.status_code, 200, rebuttal.text)
        categories = {cluster["category"] for cluster in rebuttal.json()["clusters"]}
        self.assertIn("novelty", categories)
        self.assertIn("reproducibility", categories)

        with patch.dict("os.environ", {"IDEA2REPO_PROVIDER": "openai_api_key"}, clear=True):
            provider = self.client.get("/provider/settings")
        self.assertEqual(provider.status_code, 200, provider.text)
        self.assertFalse(provider.json()["ok"])
        self.assertNotIn("sk-", provider.json()["report"])

    def test_github_dry_run_never_publishes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "github-dry-run"
            generate = self.client.post(
                "/generate",
                json={"idea": "agent memory benchmark", "output": str(output)},
            )
            self.assertEqual(generate.status_code, 200, generate.text)

            response = self.client.post(
                "/github/dry-run",
                json={"output": str(output), "repo_name": "demo-repo"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertTrue(payload["dry_run"])
            self.assertFalse(payload["publish_performed"])
            self.assertEqual(payload["repo_name"], "demo-repo")
            self.assertGreater(payload["would_create_issues"], 0)
            self.assertIn("title", payload["issues"][0])
            self.assertEqual(payload["issues"][0]["labels"], ["research", "todo"])
            self.assertIn("pull_request", payload)


if __name__ == "__main__":
    unittest.main()
