import tempfile
import unittest
from pathlib import Path

from idea2repo.generator import generate_research_repo
from idea2repo.github_export import build_github_export_plan, publish_with_gh
from idea2repo.permissions import PermissionDeniedError, PermissionPolicy


class GithubExportTests(unittest.TestCase):
    def test_dry_run_generates_sanitized_issue_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "github export"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")

            plan = build_github_export_plan(output, repo_name="demo repo")
            payload = plan.public_dict()

            self.assertTrue(payload["dry_run"])
            self.assertFalse(payload["publish_performed"])
            self.assertEqual(payload["repo_name"], "demo-repo")
            self.assertGreater(payload["would_create_issues"], 0)
            first_issue = payload["issues"][0]
            self.assertIn("title", first_issue)
            self.assertEqual(first_issue["labels"], ["research", "todo"])
            titles = [issue["title"] for issue in payload["issues"]]
            self.assertNotIn("Milestone: Milestone Exit Criteria", titles)
            milestone = next(
                issue for issue in payload["issues"]
                if issue["title"].startswith("Milestone: M1")
            )
            self.assertIn("Related-work matrix has verified papers", milestone["body"])
            self.assertNotIn("Exit criteria: Planned", milestone["body"])
            self.assertNotIn("sk-", plan.json())

    def test_dry_run_refuses_secret_like_issue_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "secret-export"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            todo = output / "docs/execution_plan/todo.md"
            todo.write_text("- Do not export sk-live-secret\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "secret-like") as context:
                build_github_export_plan(output)
            self.assertNotIn("sk-live-secret", str(context.exception))

    def test_publish_is_denied_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "denied"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            plan = build_github_export_plan(output)
            commands: list[list[str]] = []

            with self.assertRaises(PermissionDeniedError):
                publish_with_gh(plan, runner=lambda command, *, cwd: commands.append(list(command)))

            self.assertEqual(commands, [])

    def test_publish_uses_mocked_gh_when_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "allowed"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            plan = build_github_export_plan(output, repo_name="allowed")
            calls: list[tuple[list[str], Path]] = []

            result = publish_with_gh(
                plan,
                permission_policy=PermissionPolicy(allow_publish=True),
                runner=lambda command, *, cwd: calls.append((list(command), cwd)),
            )

            self.assertTrue(result.publish_performed)
            self.assertEqual(calls[0][0], ["git", "init"])
            add_commands = [call[0] for call in calls if call[0][:3] == ["git", "add", "--"]]
            self.assertTrue(add_commands)
            self.assertTrue(any("README.md" in command for command in add_commands))
            self.assertFalse(any("--all" in command for command in add_commands))
            commit_command = next(call[0] for call in calls if "commit" in call[0])
            self.assertEqual(commit_command[:6], ["git", "-c", "user.name=Idea2Repo", "-c", "user.email=idea2repo@example.invalid", "commit"])
            self.assertIn("--allow-empty", commit_command)
            create_command = next(call[0] for call in calls if call[0][:3] == ["gh", "repo", "create"])
            self.assertEqual(create_command[:4], ["gh", "repo", "create", "allowed"])
            self.assertIn("--push", create_command)
            source_index = create_command.index("--source") + 1
            self.assertNotEqual(create_command[source_index], str(output.resolve()))
            self.assertEqual(Path(create_command[source_index]).name, output.name)
            self.assertTrue(any(call[0][:3] == ["gh", "issue", "create"] for call in calls))
            self.assertTrue(all(cwd != output.resolve() for _, cwd in calls))

    def test_publish_stages_only_candidate_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "candidate-stage"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            (output / ".gitignore").write_text("# user removed ignore rules\n", encoding="utf-8")
            (output / "leaked.key").write_text("Authorization: Bearer secret-token", encoding="utf-8")
            plan = build_github_export_plan(output, create_issues=False)
            calls: list[tuple[list[str], Path]] = []

            publish_with_gh(
                plan,
                permission_policy=PermissionPolicy(allow_publish=True),
                runner=lambda command, *, cwd: calls.append((list(command), cwd)),
            )

            add_commands = [call[0] for call in calls if call[0][:3] == ["git", "add", "--"]]
            self.assertTrue(add_commands)
            self.assertFalse(any("leaked.key" in command for command in add_commands))
            self.assertTrue(any("README.md" in command for command in add_commands))

    def test_publish_does_not_stage_unscanned_binary_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "binary-stage"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            (output / ".gitignore").write_text("# user removed ignore rules\n", encoding="utf-8")
            (output / "artifact.bin").write_bytes(b"\xff\xfe\x00\x81")
            plan = build_github_export_plan(output, create_issues=False)
            calls: list[tuple[list[str], Path]] = []

            publish_with_gh(
                plan,
                permission_policy=PermissionPolicy(allow_publish=True),
                runner=lambda command, *, cwd: calls.append((list(command), cwd)),
            )

            add_commands = [call[0] for call in calls if call[0][:3] == ["git", "add", "--"]]
            self.assertTrue(add_commands)
            self.assertFalse(any("artifact.bin" in command for command in add_commands))
            self.assertTrue(any("README.md" in command for command in add_commands))

    def test_publish_scans_repo_files_before_any_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "secret-file"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            (output / "README.md").write_text("Authorization: Bearer secret-token", encoding="utf-8")
            plan = build_github_export_plan(output, create_issues=False)
            calls: list[tuple[list[str], Path]] = []

            with self.assertRaisesRegex(ValueError, "secret-like material"):
                publish_with_gh(
                    plan,
                    permission_policy=PermissionPolicy(allow_publish=True),
                    runner=lambda command, *, cwd: calls.append((list(command), cwd)),
                )

            self.assertEqual(calls, [])

    def test_publish_scans_publishable_generated_readmes(self) -> None:
        for relative_path in (
            "results/README.md",
            "docs/reference/pdfs/README.md",
            ".env.example",
            "debug.log",
            "trace.har",
        ):
            with self.subTest(relative_path=relative_path):
                with tempfile.TemporaryDirectory() as tmp:
                    output = Path(tmp) / "secret-publishable-readme"
                    generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
                    (output / relative_path).write_text(
                        "Authorization: Bearer secret-token",
                        encoding="utf-8",
                    )
                    plan = build_github_export_plan(output, create_issues=False)
                    calls: list[tuple[list[str], Path]] = []

                    with self.assertRaisesRegex(ValueError, "secret-like material"):
                        publish_with_gh(
                            plan,
                            permission_policy=PermissionPolicy(allow_publish=True),
                            runner=lambda command, *, cwd: calls.append((list(command), cwd)),
                        )

                    self.assertEqual(calls, [])

    def test_publish_refuses_json_and_yaml_secret_material(self) -> None:
        for content in (
            '{"api_key":"abc123"}',
            '{"client-secret":"abc123"}',
            '{"github-token":"abc123"}',
            '{"x-api-key":"abc123"}',
            "password: hunter2",
            '{"database_url":"postgres://user:pass@example/db"}',
            "SQLALCHEMY_DATABASE_URI=postgresql+psycopg2://user:pass@example/db",
            "DATABASE_URL: postgres://user:pass@example/db",
        ):
            with self.subTest(content=content):
                with tempfile.TemporaryDirectory() as tmp:
                    output = Path(tmp) / "structured-secret"
                    generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
                    (output / "README.md").write_text(content, encoding="utf-8")
                    plan = build_github_export_plan(output, create_issues=False)
                    calls: list[tuple[list[str], Path]] = []

                    with self.assertRaisesRegex(ValueError, "secret-like material"):
                        publish_with_gh(
                            plan,
                            permission_policy=PermissionPolicy(allow_publish=True),
                            runner=lambda command, *, cwd: calls.append((list(command), cwd)),
                        )

                    self.assertEqual(calls, [])

    def test_publish_skips_sensitive_local_files_even_when_gitignore_is_edited(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "edited-gitignore"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            (output / ".gitignore").write_text("# user edited ignore rules\n", encoding="utf-8")
            (output / ".env").write_text("GITHUB_TOKEN=ghp_local_token", encoding="utf-8")
            (output / "Credentials.JSON").write_text('{"token":"local"}', encoding="utf-8")
            (output / "credentials").write_text("opaque local credential", encoding="utf-8")
            (output / "github-token.txt").write_text("opaque local token", encoding="utf-8")
            (output / "service-account-credentials.json").write_text("opaque", encoding="utf-8")
            (output / ".aws").mkdir()
            (output / ".aws" / "credentials").write_text("opaque aws credential", encoding="utf-8")
            (output / "token.json").write_text('{"access":"local"}', encoding="utf-8")
            (output / ".netrc").write_text(
                "machine github.com login alice password local-secret",
                encoding="utf-8",
            )
            (output / "id_rsa").write_text(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nlocal\n-----END OPENSSH PRIVATE KEY-----",
                encoding="utf-8",
            )
            plan = build_github_export_plan(output, create_issues=False)
            calls: list[tuple[list[str], Path]] = []

            publish_with_gh(
                plan,
                permission_policy=PermissionPolicy(allow_publish=True),
                runner=lambda command, *, cwd: calls.append((list(command), cwd)),
            )

            add_commands = [call[0] for call in calls if call[0][:3] == ["git", "add", "--"]]
            self.assertTrue(add_commands)
            staged_paths = [
                item
                for command in add_commands
                for item in command[3:]
            ]
            self.assertNotIn(".env", staged_paths)
            self.assertNotIn("Credentials.JSON", staged_paths)
            self.assertNotIn("credentials", staged_paths)
            self.assertNotIn("github-token.txt", staged_paths)
            self.assertNotIn("service-account-credentials.json", staged_paths)
            self.assertNotIn(".aws/credentials", staged_paths)
            self.assertNotIn("token.json", staged_paths)
            self.assertNotIn(".netrc", staged_paths)
            self.assertNotIn("id_rsa", staged_paths)

    @unittest.skipUnless(hasattr(Path, "symlink_to"), "symlinks are not supported")
    def test_publish_skips_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "symlink-source"
            external = Path(tmp) / "outside.txt"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            external.write_text("outside local content", encoding="utf-8")
            link = output / "outside-link.txt"
            try:
                link.symlink_to(external)
            except OSError as exc:
                self.skipTest(f"symlink creation unavailable: {exc}")
            plan = build_github_export_plan(output, create_issues=False)
            calls: list[tuple[list[str], Path]] = []

            publish_with_gh(
                plan,
                permission_policy=PermissionPolicy(allow_publish=True),
                runner=lambda command, *, cwd: calls.append((list(command), cwd)),
            )

            add_commands = [call[0] for call in calls if call[0][:3] == ["git", "add", "--"]]
            self.assertTrue(add_commands)
            staged_paths = [
                item
                for command in add_commands
                for item in command[3:]
            ]
            self.assertNotIn("outside-link.txt", staged_paths)

    def test_publish_ignores_existing_source_git_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "source-git-state"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            (output / ".git").mkdir()
            (output / ".git" / "index").write_bytes(b"pretend staged secret")
            plan = build_github_export_plan(output, create_issues=False)
            calls: list[tuple[list[str], Path]] = []

            publish_with_gh(
                plan,
                permission_policy=PermissionPolicy(allow_publish=True),
                runner=lambda command, *, cwd: calls.append((list(command), cwd)),
            )

            self.assertTrue(calls)
            self.assertTrue(all(cwd != output.resolve() for _, cwd in calls))

    def test_publish_ignores_case_variant_sensitive_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "case-variant-dirs"
            generate_research_repo("agent memory benchmark", output, created_at="2026-05-10")
            (output / ".GIT").mkdir()
            (output / ".GIT" / "config").write_text("pretend config", encoding="utf-8")
            (output / ".VENv").mkdir()
            (output / ".VENv" / "pyvenv.cfg").write_text("home = local", encoding="utf-8")
            plan = build_github_export_plan(output, create_issues=False)
            calls: list[tuple[list[str], Path]] = []

            publish_with_gh(
                plan,
                permission_policy=PermissionPolicy(allow_publish=True),
                runner=lambda command, *, cwd: calls.append((list(command), cwd)),
            )

            add_commands = [call[0] for call in calls if call[0][:3] == ["git", "add", "--"]]
            staged_paths = [
                item
                for command in add_commands
                for item in command[3:]
            ]
            self.assertNotIn(".GIT/config", staged_paths)
            self.assertNotIn(".VENv/pyvenv.cfg", staged_paths)


if __name__ == "__main__":
    unittest.main()
