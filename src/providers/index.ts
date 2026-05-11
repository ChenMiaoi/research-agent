import { CODEX_CLI_PROVIDER_ID, OFFLINE_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../providers.js";
import { OpenAICodexOAuthAdapter } from "./codex-oauth.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { OfflineAdapter } from "./offline.js";
import type { ProviderAdapter } from "./adapter.js";

export function createProviderAdapter(id: string): ProviderAdapter {
  if (id === OFFLINE_PROVIDER_ID) return new OfflineAdapter();
  if (id === OPENAI_CODEX_PROVIDER_ID) return new OpenAICodexOAuthAdapter();
  if (id === CODEX_CLI_PROVIDER_ID) return new CodexCliAdapter();
  throw new Error(`unsupported provider adapter: ${id}`);
}

export { OpenAICodexOAuthAdapter } from "./codex-oauth.js";
export { CodexCliAdapter, extractStructuredJson, type CodexCliRunner, type CodexCliRunResult } from "./codex-cli.js";
export { OfflineAdapter, offlineResearchAnalysis } from "./offline.js";
export type { ProviderAdapter, StructuredRequest, ProviderAdapterStatus } from "./adapter.js";
