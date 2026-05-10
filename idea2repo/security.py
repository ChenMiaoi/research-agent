"""Dual-use security guardrails for research idea handling."""

from __future__ import annotations

import re
from dataclasses import dataclass


HARMFUL_MARKERS = (
    "steal credentials",
    "credential theft",
    "credential stealer",
    "credential stealing",
    "password stealer",
    "password stealing",
    "token stealer",
    "session stealer",
    "exfiltrate",
    "exfiltration",
    "exfiltrating",
    "exfil",
    "keylogger",
    "botnet",
    "persistence",
    "privilege escalation",
    "bypass detection",
    "edr bypass",
    "av bypass",
    "antivirus bypass",
    "waf bypass",
    "bypass chain",
    "evasion chain",
    "evade antivirus",
    "weaponize",
    "real target",
    "phishing kit",
    "exploit chain",
    "exploit poc",
    "proof of concept exploit",
    "reverse shell",
    "c2",
    "command and control",
    "payload",
    "token harvesting",
    "password harvesting",
    "dump tokens",
    "dump passwords",
    "real host",
    "real domain",
    "public ip",
)

SENSITIVE_SUBJECTS = (
    "malware",
    "ransomware",
    "phishing",
)

SECURITY_MARKERS = (
    "security",
    "privacy",
    "jailbreak",
    "exploit",
    "vulnerability",
    "attack",
    "threat",
    "malware",
    "red team",
    "audit",
    "bypass",
    "evasion",
    "endpoint protection",
    "exfil",
    "exfiltration",
)

DEFENSIVE_MARKERS = (
    "defense",
    "detect",
    "detection",
    "mitigate",
    "mitigation",
    "benchmark",
    "evaluate",
    "audit",
    "responsible disclosure",
    "sandbox",
    "policy",
    "false positive",
    "false negative",
    "synthetic",
    "owned",
    "lab",
    "ctf",
)

HARMFUL_PATTERNS = (
    r"\b(?:steal|harvest|grab|dump|dumping|exfil|exfiltrate|exfiltrating|exfiltration|theft)\b.{0,40}\b(?:credential|credentials|password|passwords|token|tokens|session|sessions)\b",
    r"\b(?:credential|credentials|password|passwords|token|tokens|session|sessions)\b.{0,40}\b(?:steal|stealer|stealing|harvest|harvesting|grab|dump|dumping|exfil|exfiltrate|exfiltrating|exfiltration|theft)\b",
    r"\b(?:bypass|evade|evasion)\b.{0,40}\b(?:edr|av|antivirus|waf|endpoint|endpoint detection|endpoint security|endpoint protection)\b",
    r"\b(?:edr|av|antivirus|waf|endpoint|endpoint detection|endpoint security|endpoint protection)\b.{0,40}\b(?:bypass|evade|evasion)\b",
)


@dataclass(frozen=True)
class SecurityAssessment:
    """Security scope classification and output constraints."""

    security_relevant: bool
    allowed: bool
    scope: str
    reasons: tuple[str, ...]
    required_boundaries: tuple[str, ...]


def assess_security_scope(idea: str) -> SecurityAssessment:
    lowered = idea.casefold()
    security_relevant = any(marker in lowered for marker in SECURITY_MARKERS)
    sensitive_subject = any(marker in lowered for marker in SENSITIVE_SUBJECTS)
    defensive = any(marker in lowered for marker in DEFENSIVE_MARKERS)
    harmful = tuple(
        marker for marker in HARMFUL_MARKERS
        if marker in lowered and not _defensive_sensitive_context(marker, lowered, defensive=defensive)
    )
    harmful_patterns = tuple(
        f"pattern:{pattern}"
        for pattern in HARMFUL_PATTERNS
        if re.search(pattern, lowered) and not _defensive_pattern_context(lowered, defensive=defensive)
    )
    has_real_target_indicator = _has_unsafe_ip_target(lowered)
    has_real_target_indicator = has_real_target_indicator or _has_external_domain(lowered)
    if sensitive_subject:
        security_relevant = True
    if harmful or harmful_patterns or has_real_target_indicator:
        reasons = tuple(f"disallowed_operational_detail:{marker}" for marker in harmful)
        reasons = reasons + tuple(f"disallowed_operational_detail:{pattern}" for pattern in harmful_patterns)
        if has_real_target_indicator:
            reasons = reasons + ("disallowed_operational_detail:real_target_indicator",)
        return SecurityAssessment(
            security_relevant=True,
            allowed=False,
            scope="defensive_reframe_required",
            reasons=reasons,
            required_boundaries=_boundaries(),
        )
    if security_relevant:
        return SecurityAssessment(
            security_relevant=True,
            allowed=defensive,
            scope="defensive_or_evaluation" if defensive else "requires_defensive_scope",
            reasons=() if defensive else ("security idea needs explicit defensive framing",),
            required_boundaries=_boundaries(),
        )
    return SecurityAssessment(
        security_relevant=False,
        allowed=True,
        scope="not_security_specific",
        reasons=(),
        required_boundaries=(),
    )


def safe_security_reframe(idea: str, assessment: SecurityAssessment) -> str:
    if assessment.allowed:
        return idea
    return (
        "Defensive research reframe: evaluate, detect, and mitigate the described risk in an "
        "owned lab or synthetic benchmark. Do not generate operational abuse instructions, "
        "evasion guidance, persistence logic, or steps against real targets."
    )


def security_guardrail_markdown(assessment: SecurityAssessment) -> str:
    reasons = ", ".join(assessment.reasons) or "none"
    boundaries = "\n".join(f"- {boundary}" for boundary in assessment.required_boundaries) or "- none"
    return f"""# Security Guardrail

- Security relevant: {_yes_no(assessment.security_relevant)}
- Allowed as provided: {_yes_no(assessment.allowed)}
- Scope: {assessment.scope}
- Reasons: {reasons}

## Required Boundaries

{boundaries}

## Output Policy

- Support defensive evaluation, detection, mitigation, auditing, and responsible disclosure.
- Do not provide executable attack chains, malware behavior, credential theft, persistence,
  evasion, or real-target exploitation steps.
"""


def _boundaries() -> tuple[str, ...]:
    return (
        "Use owned systems, synthetic targets, or public benchmark data only.",
        "Write the threat model before experiments.",
        "Measure false positives, false negatives, and defensive utility.",
        "Document ethical handling and responsible disclosure when applicable.",
    )


def _yes_no(value: bool) -> str:
    return "yes" if value else "no"


def _has_external_domain(text: str) -> bool:
    hosts = set()
    for match in re.findall(r"https?://([a-z0-9.-]+\.[a-z]{2,})", text):
        hosts.add(match)
    for match in re.findall(r"\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b", text):
        hosts.add(match)
    return any(not _is_placeholder_host(host) for host in hosts)


def _is_placeholder_host(host: str) -> bool:
    host = host.strip(".").casefold()
    placeholder_hosts = {
        "localhost",
        "example.com",
        "example.org",
        "example.net",
        "test.invalid",
    }
    if host in placeholder_hosts:
        return True
    return host.endswith(".example.com") or host.endswith(".example.org") or host.endswith(".example.net")


def _has_unsafe_ip_target(text: str) -> bool:
    ips = re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", text)
    if not ips:
        return False
    context_allows_reserved = any(marker in text for marker in ("owned", "synthetic", "benchmark", "lab", "ctf"))
    for ip in ips:
        parts = [int(part) for part in ip.split(".") if part.isdigit()]
        if len(parts) != 4 or any(part > 255 for part in parts):
            return True
        reserved = (
            parts[0] == 10
            or parts[0] == 127
            or (parts[0] == 172 and 16 <= parts[1] <= 31)
            or (parts[0] == 192 and parts[1] == 168)
            or (parts[0] == 192 and parts[1] == 0 and parts[2] == 2)
            or (parts[0] == 198 and parts[1] == 51 and parts[2] == 100)
            or (parts[0] == 203 and parts[1] == 0 and parts[2] == 113)
        )
        if not (reserved and context_allows_reserved):
            return True
    return False


def _defensive_sensitive_context(marker: str, text: str, *, defensive: bool) -> bool:
    if not defensive:
        return False
    if marker in {"phishing kit", "payload"}:
        return any(word in text for word in ("detect", "detection", "benchmark", "audit", "mitigation", "analysis"))
    if marker in {"exfil", "exfiltrate", "exfiltrating", "exfiltration", "bypass detection"}:
        return _defensive_pattern_context(text, defensive=defensive)
    return False


def _defensive_pattern_context(text: str, *, defensive: bool) -> bool:
    if not defensive:
        return False
    if not any(marker in text for marker in ("synthetic", "owned", "benchmark", "lab", "audit", "evaluation")):
        return False
    if any(marker in text for marker in ("build ", "write ", "create ", "tool to", "against ", "from users", "from a browser")):
        return False
    return True
