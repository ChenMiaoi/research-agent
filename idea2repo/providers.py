"""Provider configuration and credential-safety helpers."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from enum import Enum
from typing import Mapping


SECRET_ENV_VARS = (
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ENTERPRISE_GATEWAY_URL",
    "LOCAL_MODEL_ENDPOINT",
)


class ProviderMode(str, Enum):
    """Supported provider modes without private login or cookie scraping."""

    OFFLINE = "offline"
    OPENAI_ACCOUNT = "openai_account"
    OPENAI_API_KEY = "openai_api_key"
    ENTERPRISE_GATEWAY = "enterprise_gateway"
    LOCAL_MODEL = "local_model"


@dataclass(frozen=True)
class ProviderConfig:
    """Safe provider config loaded from environment or explicit values."""

    mode: ProviderMode = ProviderMode.OFFLINE
    openai_base_url: str | None = None
    enterprise_gateway_url: str | None = None
    local_model_endpoint: str | None = None

    def public_dict(self, env: Mapping[str, str] | None = None) -> dict[str, object]:
        env = os.environ if env is None else env
        return {
            "mode": self.mode.value,
            "auth_boundary": auth_boundary(self.mode),
            "openai_api_key": _presence(env, "OPENAI_API_KEY"),
            "openai_base_url": _redact(self.openai_base_url or env.get("OPENAI_BASE_URL")),
            "enterprise_gateway_url": _redact(
                self.enterprise_gateway_url or env.get("ENTERPRISE_GATEWAY_URL")
            ),
            "local_model_endpoint": _redact(
                self.local_model_endpoint or env.get("LOCAL_MODEL_ENDPOINT")
            ),
        }


def load_provider_config(env: Mapping[str, str] | None = None) -> ProviderConfig:
    env = os.environ if env is None else env
    raw_mode = env.get("IDEA2REPO_PROVIDER", ProviderMode.OFFLINE.value)
    try:
        mode = ProviderMode(raw_mode)
    except ValueError as exc:
        allowed = ", ".join(mode.value for mode in ProviderMode)
        raise ValueError(f"unsupported provider mode: {raw_mode}. Allowed: {allowed}") from exc
    return ProviderConfig(
        mode=mode,
        openai_base_url=env.get("OPENAI_BASE_URL") or None,
        enterprise_gateway_url=env.get("ENTERPRISE_GATEWAY_URL") or None,
        local_model_endpoint=env.get("LOCAL_MODEL_ENDPOINT") or None,
    )


def validate_provider_config(
    config: ProviderConfig | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[str, ...]:
    env = os.environ if env is None else env
    config = config or load_provider_config(env)
    errors: list[str] = []
    if config.mode == ProviderMode.OPENAI_API_KEY and not env.get("OPENAI_API_KEY"):
        errors.append("OPENAI_API_KEY is required for openai_api_key provider mode")
    if config.mode == ProviderMode.ENTERPRISE_GATEWAY and not (
        config.enterprise_gateway_url or env.get("ENTERPRISE_GATEWAY_URL")
    ):
        errors.append("ENTERPRISE_GATEWAY_URL is required for enterprise_gateway provider mode")
    if config.mode == ProviderMode.LOCAL_MODEL and not (
        config.local_model_endpoint or env.get("LOCAL_MODEL_ENDPOINT")
    ):
        errors.append("LOCAL_MODEL_ENDPOINT is required for local_model provider mode")
    return tuple(errors)


def auth_boundary(mode: ProviderMode) -> str:
    if mode == ProviderMode.OPENAI_ACCOUNT:
        return (
            "Use only official OpenAI account login mechanisms when available; "
            "never capture cookies or call private ChatGPT endpoints."
        )
    if mode == ProviderMode.OPENAI_API_KEY:
        return "Read API keys from environment or OS credential storage; never write them to repo files."
    if mode == ProviderMode.ENTERPRISE_GATEWAY:
        return "Use an organization-approved gateway URL and external credential storage."
    if mode == ProviderMode.LOCAL_MODEL:
        return "Use a local endpoint without sending project data to hosted providers."
    return "Offline mode writes deterministic placeholders and performs no model calls."


def provider_schema() -> dict[str, object]:
    return {
        "version": 1,
        "default": ProviderMode.OFFLINE.value,
        "modes": {
            mode.value: {
                "auth_boundary": auth_boundary(mode),
                "required_environment": _required_environment(mode),
            }
            for mode in ProviderMode
        },
        "secret_policy": {
            "never_write": [
                "tokens",
                "cookies",
                "API keys",
                "private provider responses",
                "browser profile state",
            ],
            "redacted_environment": list(SECRET_ENV_VARS),
        },
    }


def provider_schema_json() -> str:
    return json.dumps(provider_schema(), indent=2, sort_keys=True) + "\n"


def safe_provider_report(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    config = load_provider_config(env)
    errors = validate_provider_config(config, env)
    summary = config.public_dict(env)
    lines = [
        "# Provider Configuration",
        "",
        "## Active Mode",
        "",
        f"- Mode: {summary['mode']}",
        f"- Boundary: {summary['auth_boundary']}",
        f"- OPENAI_API_KEY: {summary['openai_api_key']}",
        f"- OPENAI_BASE_URL: {summary['openai_base_url']}",
        f"- ENTERPRISE_GATEWAY_URL: {summary['enterprise_gateway_url']}",
        f"- LOCAL_MODEL_ENDPOINT: {summary['local_model_endpoint']}",
        "",
        "## Validation",
        "",
    ]
    if errors:
        lines.extend(f"- {error}" for error in errors)
    else:
        lines.append("- ok")
    lines.extend(
        [
            "",
            "## Credential Rules",
            "",
            "- Do not store tokens, cookies, API keys, or private provider responses in this repository.",
            "- OpenAI account login is an official-boundary placeholder; do not scrape browser cookies.",
            "- Prefer OS credential storage or environment variables for secrets.",
        ]
    )
    return "\n".join(lines) + "\n"


def contains_secret_material(text: str) -> bool:
    lowered = text.casefold()
    markers = (
        "sk-",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "session_token",
        "refresh_token",
        "access_token=",
        "github_token=",
        "aws_secret_access_key=",
        "cookie:",
        "set-cookie:",
        "authorization: bearer",
        "-----begin openssh private key-----",
        "-----begin rsa private key-----",
        "-----begin dsa private key-----",
        "-----begin ec private key-----",
        "-----begin private key-----",
    )
    if any(marker in lowered for marker in markers):
        return True
    assignment_patterns = (
        r"\b[a-z0-9_-]*(?:api[_-]?key|token|secret|password)[ \t]*[=:][ \t]*(?!set\b|unset\b|<redacted\b)['\"]?[^'\"\s#,\]}]+",
        r"['\"][a-z0-9_-]*(?:api[_-]?key|token|secret|password)['\"][ \t]*:[ \t]*['\"](?!set['\"]|unset['\"]|<redacted)[^'\"]+['\"]",
        r"\b[a-z0-9_-]*(?:database|db)[a-z0-9_-]*(?:url|uri)[ \t]*[=:][ \t]*['\"]?[a-z][a-z0-9+.-]*://[^'\"\s]+:[^'\"\s]+@",
        r"['\"][a-z0-9_-]*(?:database|db)[a-z0-9_-]*(?:url|uri)['\"][ \t]*:[ \t]*['\"][a-z][a-z0-9+.-]*://[^'\"]+:[^'\"]+@[^'\"]+['\"]",
        r"\bmachine\s+\S+\s+login\s+\S+\s+password\s+\S+",
    )
    return any(re.search(pattern, lowered) for pattern in assignment_patterns)


def _required_environment(mode: ProviderMode) -> list[str]:
    if mode == ProviderMode.OPENAI_API_KEY:
        return ["OPENAI_API_KEY"]
    if mode == ProviderMode.ENTERPRISE_GATEWAY:
        return ["ENTERPRISE_GATEWAY_URL"]
    if mode == ProviderMode.LOCAL_MODEL:
        return ["LOCAL_MODEL_ENDPOINT"]
    return []


def _presence(env: Mapping[str, str], key: str) -> str:
    return "set" if env.get(key) else "unset"


def _redact(value: str | None) -> str:
    if not value:
        return "unset"
    if len(value) <= 8:
        return "<redacted>"
    return f"{value[:4]}...{value[-4:]} (redacted)"
