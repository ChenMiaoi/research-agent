"""Provider configuration and credential-safety helpers."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Mapping

from .auth import STATE_HOME_ENV, AuthProvider


SECRET_ENV_VARS = (
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ENTERPRISE_GATEWAY_URL",
    "LOCAL_MODEL_ENDPOINT",
)


class ProviderMode(str, Enum):
    """Supported provider modes without reading Codex auth files or browser cookies."""

    OPENAI_CODEX_OAUTH = "openai-codex-oauth"
    OPENAI_CODEX_CLI = "openai-codex-cli"
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
        explicit_env = env is not None
        env = os.environ if env is None else env
        auth_provider = _auth_provider_for_env(env, explicit_env)
        auth_session = auth_provider.current_session()
        return {
            "mode": self.mode.value,
            "auth_boundary": auth_boundary(self.mode),
            "openai_account": _openai_account_status(auth_session.public_dict()),
            "openai_api_key": _api_key_status(env, auth_session.public_dict()),
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
    raw_mode = env.get("IDEA2REPO_PROVIDER", ProviderMode.OPENAI_CODEX_OAUTH.value)
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
    explicit_env = env is not None
    env = os.environ if env is None else env
    config = config or load_provider_config(env)
    errors: list[str] = []
    auth_provider = _auth_provider_for_env(env, explicit_env)
    auth_session = auth_provider.current_session()
    if config.mode in {ProviderMode.OPENAI_CODEX_OAUTH, ProviderMode.OPENAI_ACCOUNT} and not auth_session.is_authenticated:
        errors.append(f"OpenAI account login is required for {config.mode.value} provider mode")
    if config.mode in {ProviderMode.OPENAI_CODEX_OAUTH, ProviderMode.OPENAI_ACCOUNT} and auth_session.is_expired:
        errors.append("OpenAI account login is expired; run idea2repo auth login")
    if config.mode == ProviderMode.OPENAI_API_KEY and not (
        env.get("OPENAI_API_KEY") or auth_session.mode == "openai_api_key"
    ):
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
    if mode == ProviderMode.OPENAI_CODEX_OAUTH:
        return (
            "Use Idea2Repo-managed OpenAI OAuth credentials stored under ~/.idea2repo; "
            "never read ~/.codex auth files or browser cookies."
        )
    if mode == ProviderMode.OPENAI_CODEX_CLI:
        return "Use the official Codex CLI as an explicit provider."
    if mode == ProviderMode.OPENAI_ACCOUNT:
        return (
            "Legacy alias for Idea2Repo-managed OpenAI account OAuth."
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
        "default": ProviderMode.OPENAI_CODEX_OAUTH.value,
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
            "user_state_directory": "~/.idea2repo/agent/codex",
            "auth_metadata_file": "~/.idea2repo/agent/codex/auth.json",
            "config_file": "~/.idea2repo/agent/codex/config.json",
            "credentials_file": "~/.idea2repo/agent/codex/credentials.json",
            "secret_storage": "file_credentials",
        },
    }


def provider_schema_json() -> str:
    return json.dumps(provider_schema(), indent=2, sort_keys=True) + "\n"


def safe_provider_report(env: Mapping[str, str] | None = None) -> str:
    explicit_env = env is not None
    active_env = os.environ if env is None else env
    config = load_provider_config(active_env)
    report_env = active_env if explicit_env else None
    errors = validate_provider_config(config, report_env)
    summary = config.public_dict(report_env)
    lines = [
        "# Provider Configuration",
        "",
        "## Active Mode",
        "",
        f"- Mode: {summary['mode']}",
        f"- Boundary: {summary['auth_boundary']}",
        f"- OpenAI account: {summary['openai_account']}",
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
            "- Store Idea2Repo auth metadata under ~/.idea2repo/agent/codex.",
            "- Store access tokens and refresh tokens in ~/.idea2repo/agent/codex/credentials.json.",
            "- Never read ~/.codex auth files or scrape browser cookies.",
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


def _redact(value: str | None) -> str:
    if not value:
        return "unset"
    if len(value) <= 8:
        return "<redacted>"
    return f"{value[:4]}...{value[-4:]} (redacted)"


def _api_key_status(env: Mapping[str, str], session: Mapping[str, object]) -> str:
    if env.get("OPENAI_API_KEY") or session.get("mode") == "openai_api_key":
        return "set"
    return "unset"


def _openai_account_status(session: Mapping[str, object]) -> str:
    if session.get("authenticated") is True and session.get("mode") == "openai_account":
        label = str(session.get("account_label") or "logged in")
        return label
    return "not logged in"


def _auth_provider_for_env(env: Mapping[str, str], explicit_env: bool) -> AuthProvider:
    if not explicit_env:
        return AuthProvider(env=env)
    state_home = env.get(STATE_HOME_ENV) or Path("/__idea2repo_empty_auth_state__")
    return AuthProvider(env=env, state_home=state_home)
