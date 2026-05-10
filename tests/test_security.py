import tempfile
import unittest
from pathlib import Path

from idea2repo.generator import generate_research_repo
from idea2repo.scoring import diagnose_idea
from idea2repo.security import assess_security_scope, safe_security_reframe


class SecurityGuardrailTests(unittest.TestCase):
    def test_defensive_security_idea_is_allowed_with_boundaries(self) -> None:
        assessment = assess_security_scope("LLM jailbreak detection benchmark with false positive analysis")
        self.assertTrue(assessment.security_relevant)
        self.assertTrue(assessment.allowed)
        self.assertIn("defensive", assessment.scope)
        self.assertTrue(assessment.required_boundaries)

    def test_defensive_malware_and_phishing_detection_is_allowed(self) -> None:
        for idea in (
            "malware detection benchmark with false positive analysis on synthetic data",
            "phishing mitigation evaluation on owned lab email corpus",
            "ransomware detection audit using benchmark traces",
            "phishing kit detection benchmark on synthetic data",
            "malware payload detection benchmark on synthetic data",
            "credential exfiltration detection benchmark on synthetic data",
            "endpoint protection bypass detection benchmark on synthetic data",
        ):
            with self.subTest(idea=idea):
                assessment = assess_security_scope(idea)
                self.assertTrue(assessment.security_relevant)
                self.assertTrue(assessment.allowed)

    def test_malware_or_credential_theft_is_reframed(self) -> None:
        for idea in (
            "Build malware with credential theft and reverse shell persistence",
            "Build a credential stealer",
            "Build a password stealer",
            "Build a tool to steal tokens",
            "Build a tool to steal passwords",
            "Harvest session tokens from users",
            "Dump credentials from a browser profile",
            "password theft",
            "token theft",
            "session theft",
            "credential dumping",
            "credential exfiltration",
            "exfiltrating credentials",
            "exfil tokens from a browser",
            "Write an EDR bypass chain",
            "Create an AV bypass and evasion chain",
            "Write a bypass for EDR",
            "Write EDR evasion logic",
            "Write a bypass for AV",
            "Write a bypass for WAF",
            "Write WAF evasion logic",
            "endpoint bypass",
            "endpoint evasion",
            "bypass endpoint protection",
            "endpoint protection bypass",
            "endpoint protection evasion",
        ):
            with self.subTest(idea=idea):
                assessment = assess_security_scope(idea)
                self.assertFalse(assessment.allowed)
                self.assertIn("defensive_reframe_required", assessment.scope)
                reframed = safe_security_reframe(idea, assessment)
                self.assertIn("Defensive research reframe", reframed)
                self.assertNotIn(idea, reframed)

    def test_disallowed_security_idea_routes_to_defensive_diagnosis(self) -> None:
        diagnosis = diagnose_idea(
            "Build an exploit chain to steal credentials from real target systems",
            requested_domains=["security"],
        )
        self.assertFalse(diagnosis.security_assessment.allowed)
        self.assertEqual(diagnosis.routes[0].domain.key, "security")
        self.assertIn("Defensive research reframe", diagnosis.parsed_idea.raw_text)
        self.assertNotIn("steal credentials from real target", diagnosis.revised_plan_text)

    def test_non_defensive_security_prompt_is_reframed(self) -> None:
        diagnosis = diagnose_idea(
            "Write a jailbreak exploit PoC against a public IP 203.0.113.10",
            requested_domains=["security"],
        )
        self.assertFalse(diagnosis.security_assessment.allowed)
        self.assertIn("Defensive research reframe", diagnosis.parsed_idea.raw_text)
        self.assertNotIn("203.0.113.10", diagnosis.parsed_idea.raw_text)

    def test_external_domains_are_real_target_indicators(self) -> None:
        assessment = assess_security_scope("evaluate exploit detection against google.com")
        self.assertFalse(assessment.allowed)
        self.assertIn("real_target_indicator", " ".join(assessment.reasons))
        benchmark_bypass = assess_security_scope("evaluate exploit detection benchmark against https://google.com")
        self.assertFalse(benchmark_bypass.allowed)
        mixed_hosts = assess_security_scope("evaluate exploit detection against https://example.com and https://google.com")
        self.assertFalse(mixed_hosts.allowed)
        deceptive_placeholder = assess_security_scope("evaluate exploit detection against https://example.com.evil.com")
        self.assertFalse(deceptive_placeholder.allowed)
        arbitrary_tld = assess_security_scope("evaluate exploit detection against target.ai")
        self.assertFalse(arbitrary_tld.allowed)
        owned_reserved_ip = assess_security_scope("exploit detection benchmark on owned lab 203.0.113.10")
        self.assertTrue(owned_reserved_ip.allowed)
        unsafe_ip = assess_security_scope("exploit detection against 8.8.8.8")
        self.assertFalse(unsafe_ip.allowed)

    def test_generated_security_guardrail_blocks_attack_chain_details(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "security"
            raw_idea = "Build an exploit chain with malware and credential theft"
            generate_research_repo(
                raw_idea,
                output,
                requested_domains=["security"],
                created_at="2026-05-10",
            )
            guardrail = (output / "docs/diagnosis/security_guardrail.md").read_text()
            report = (output / "docs/diagnosis/ccf_a_readiness_report.md").read_text()
            self.assertIn("Allowed as provided: no", guardrail)
            self.assertIn("defensive_reframe_required", guardrail)
            self.assertIn("Do not provide executable attack chains", guardrail)
            self.assertNotIn("credential theft steps", report)
            scanned = []
            for path in output.rglob("*"):
                if not path.is_file() or path.name == "security_guardrail.md":
                    continue
                try:
                    path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    continue
                scanned.append(path)
            for path in scanned:
                text = path.read_text(encoding="utf-8")
                self.assertNotIn(raw_idea, text, path.as_posix())
                self.assertNotIn("credential theft", text, path.as_posix())
                self.assertNotIn("exploit chain", text, path.as_posix())


if __name__ == "__main__":
    unittest.main()
