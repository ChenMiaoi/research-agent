import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform, release, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import open from "open";
import { validateIdeaDiscussionTurn, validateResearchAnalysis, type IdeaDiscussionTurn, type ResearchAnalysis } from "../types.js";
import { buildAgentPrompt, stagedAgentInstructions, type AgentPromptFile } from "../agents/agent-runner.js";
import {
  validateCandidateTriage,
  validateFeasibilityReview,
  validateIdeaBrief,
  validateNoveltyGapAnalysis,
  validatePdfPaperNote,
  validateRelatedWorkAnalysis,
  validateResearchStrategy,
  validateSearchPlan,
  validateStrictCcfAReview,
  type CandidateTriage,
  type FeasibilityReview,
  type IdeaBrief,
  type NoveltyGapAnalysis,
  type PdfPaperNote,
  type RelatedWorkAnalysis,
  type ResearchStrategy,
  type SearchPlan,
  type StrictCcfAReview
} from "../agents/schemas.js";
import { filterUnsupportedModels } from "../models.js";
import { configureProxyFromEnv, proxySummary } from "../proxy.js";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export const OPENAI_CODEX_API_SHAPE = "openai-codex-responses";
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const DEFAULT_CODEX_RESPONSES_ENDPOINT = `${DEFAULT_CODEX_BASE_URL}/codex/responses`;
export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex-spark";
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OAUTH_SCOPE = "openid profile email offline_access";
export const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export type OAuthCredentials = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

export type AuthFile = Record<string, OAuthCredentials>;

export type OAuthLoginCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  openBrowser?: boolean;
};

export type CodexOAuthStatus = {
  available: boolean;
  logged_in: boolean;
  status_text: string;
  account_id?: string;
  expires?: number;
  endpoint: string;
};

export type RateLimitWindow = {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
};

export type CreditsSnapshot = {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: number | null;
};

export type CodexUsageSnapshot = {
  available: boolean;
  source: string;
  limitName?: string;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  credits?: CreditsSnapshot;
  planType?: string;
  rateLimitReachedType?: string;
};

export function stateHome(): string {
  return resolve(process.env.IDEA2REPO_HOME || join(homedir(), ".idea2repo"));
}

export function authPath(): string {
  return join(stateHome(), "agent", "codex", "auth.json");
}

export class AuthStorage {
  constructor(private readonly path = authPath()) {}

  async read(): Promise<AuthFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      const data = JSON.parse(raw) as AuthFile;
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  async write(data: AuthFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await chmod(dirname(this.path), 0o700);
    } catch {}
    const tmp = join(dirname(this.path), `.auth.${randomBytes(8).toString("hex")}.tmp`);
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
    try {
      await chmod(this.path, 0o600);
    } catch {}
  }

  async get(provider = OPENAI_CODEX_PROVIDER_ID): Promise<OAuthCredentials | null> {
    const data = await this.read();
    return data[provider] ?? null;
  }

  async set(provider: string, credentials: OAuthCredentials): Promise<void> {
    const data = await this.read();
    data[provider] = credentials;
    await this.write(data);
  }

  async logout(provider = OPENAI_CODEX_PROVIDER_ID): Promise<void> {
    const data = await this.read();
    delete data[provider];
    if (Object.keys(data).length) await this.write(data);
    else await rm(this.path, { force: true });
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const start = Date.now();
    while (existsSync(lockPath)) {
      if (Date.now() - start > 30_000) throw new Error("timed out waiting for auth storage lock");
      await sleep(50);
    }
    await writeFile(lockPath, String(process.pid), "utf8");
    try {
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

export const openaiCodexOAuthProvider = {
  id: OPENAI_CODEX_PROVIDER_ID,
  name: "ChatGPT Plus/Pro (Codex Subscription)",
  usesCallbackServer: true,
  async status(): Promise<{ loggedIn: boolean; accountId?: string; expires?: number; statusText: string; endpoint: string }> {
    const status = await new CodexOAuthClient().checkLogin();
    return {
      loggedIn: status.logged_in,
      accountId: status.account_id,
      expires: status.expires,
      statusText: status.status_text,
      endpoint: status.endpoint
    };
  },
  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return loginOpenAICodex(callbacks);
  },
  async logout(): Promise<void> {
    await new AuthStorage().logout();
  },
  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshOpenAICodexToken(credentials.refresh);
  },
  async usage(): Promise<CodexUsageSnapshot> {
    return new CodexOAuthClient().getUsage();
  },
  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
  modifyModels<T extends { provider?: string; id?: string }>(models: T[]): T[] {
    return filterUnsupportedModels(models);
  }
};

export async function loginOpenAICodex(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  const url = authorizationUrl(state, challenge);
  const server = await startLocalOAuthServer(state);
  callbacks.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });
  if (callbacks.openBrowser !== false) {
    await open(url).catch(() => undefined);
  }
  let code: string | undefined;
  try {
    if (callbacks.onManualCodeInput) {
      let manualInput: string | undefined;
      let manualError: Error | undefined;
      const manual = callbacks
        .onManualCodeInput()
        .then((input) => {
          manualInput = input;
          server.cancelWait();
        })
        .catch((error) => {
          manualError = error instanceof Error ? error : new Error(String(error));
          server.cancelWait();
        });
      const callback = await server.waitForCode();
      if (manualError) throw manualError;
      if (callback?.code) code = callback.code;
      else if (manualInput) code = parseAuthorizationInput(manualInput, state).code;
      if (!code) {
        await manual;
        if (manualError) throw manualError;
        if (manualInput) code = parseAuthorizationInput(manualInput, state).code;
      }
    } else {
      const callback = await server.waitForCode();
      if (callback?.code) code = callback.code;
    }
    if (!code) {
      const input = await callbacks.onPrompt({ message: "Paste the authorization code (or full redirect URL):" });
      code = parseAuthorizationInput(input, state).code;
    }
    if (!code) throw new Error("Missing authorization code");
    const token = await exchangeAuthorizationCode(code, verifier);
    const accountId = extractAccountId(token.access);
    return { type: "oauth", ...token, accountId };
  } finally {
    server.close();
  }
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
  const token = await postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID
  });
  return { type: "oauth", ...token, accountId: extractAccountId(token.access) };
}

export class CodexOAuthClient {
  constructor(
    private readonly options: {
      storage?: AuthStorage;
      endpoint?: string;
      model?: string;
      reasoningEffort?: string;
      originator?: string;
      sessionId?: string;
      fetchImpl?: typeof fetch;
      maxRetries?: number;
    } = {}
  ) {}

  endpoint(): string {
    return resolveCodexResponsesUrl(this.options.endpoint ?? process.env.IDEA2REPO_CODEX_RESPONSES_URL ?? DEFAULT_CODEX_BASE_URL);
  }

  model(): string {
    return this.options.model ?? process.env.IDEA2REPO_CODEX_MODEL ?? DEFAULT_CODEX_MODEL;
  }

  async checkLogin(): Promise<CodexOAuthStatus> {
    const credentials = await (this.options.storage ?? new AuthStorage()).get();
    if (!credentials) return { available: true, logged_in: false, status_text: "not logged in", endpoint: this.endpoint() };
    if (Date.now() >= credentials.expires) return { available: true, logged_in: false, status_text: "OpenAI Codex session expired", account_id: credentials.accountId, expires: credentials.expires, endpoint: this.endpoint() };
    return { available: true, logged_in: true, status_text: `logged in via openai-codex (${credentials.accountId})`, account_id: credentials.accountId, expires: credentials.expires, endpoint: this.endpoint() };
  }

  async getUsage(): Promise<CodexUsageSnapshot> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    if (!this.options.fetchImpl) configureProxyFromEnv();
    const credentials = await this.requireCredentials();
    const headers = codexHeaders(credentials.access, credentials.accountId, this.options.originator ?? "idea2repo", this.options.sessionId);
    headers.set("accept", "application/json");
    const candidates = usageEndpointCandidates(this.endpoint());
    let lastError = "";
    let best: CodexUsageSnapshot | null = null;
    for (const endpoint of candidates) {
      const response = await fetchImpl(endpoint, { method: "GET", headers });
      if (!response.ok) {
        lastError = `${response.status} ${await response.text().catch(() => response.statusText)}`;
        if (response.status === 401 || response.status === 403 || response.status === 404) continue;
        continue;
      }
      const json = (await response.json()) as unknown;
      const parsed = parseUsageSnapshot(json, endpoint);
      if (parsed.available && (parsed.primary || parsed.secondary)) return parsed;
      if (parsed.available && !best) best = parsed;
      lastError = `usage response from ${endpoint} did not include rate-limit fields`;
    }
    if (best) return best;
    throw new Error(`Codex usage limits are not available from the current backend${lastError ? `: ${lastError}` : ""}`);
  }

  async requireCredentials(): Promise<OAuthCredentials> {
    const storage = this.options.storage ?? new AuthStorage();
    return storage.withLock(async () => {
      let credentials = await storage.get();
      if (!credentials) throw new Error("Idea2Repo OAuth is not logged in. Run `idea2repo auth login` before generating.");
      if (Date.now() >= credentials.expires - 60_000) {
        credentials = await refreshOpenAICodexToken(credentials.refresh);
        await storage.set(OPENAI_CODEX_PROVIDER_ID, credentials);
      }
      return credentials;
    });
  }

  async analyzeIdea(
    idea: string,
    options: { requestedDomains?: string[]; timelineWeeks?: number; resources?: string[]; stack?: "python" | "ts"; progress?: (message: string) => void } = {}
  ): Promise<{ analysis: ResearchAnalysis; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const prompt = buildResearchPrompt(idea, options);
    options.progress?.("Codex OAuth: building structured research-analysis request");
    const payload = responsesPayload(prompt, researchInstructions(), this.model(), this.options.reasoningEffort);
    const { parsed, events } = await this.requestStructured(payload, validateResearchAnalysis, options.progress);
    return { analysis: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async intakeIdea(
    idea: string,
    context: { requestedDomains?: string[]; targetVenues?: string[]; timelineWeeks?: number; resources?: string[] } = {},
    progress?: (message: string) => void
  ): Promise<{ idea_brief: IdeaBrief; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("00_intake_router.md", "Convert the idea into a precise search-ready research brief.", { idea, ...context }, validateIdeaBrief, "IdeaBrief", progress);
    return { idea_brief: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async planLiteratureSearch(
    idea: string,
    context: { requestedDomains?: string[]; targetVenues?: string[]; timelineWeeks?: number; resources?: string[] } = {},
    progress?: (message: string) => void
  ): Promise<{ search_plan: SearchPlan; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("01_search_planner.md", "Plan literature search queries for the idea.", { idea, ...context }, validateSearchPlan, "SearchPlan", progress);
    return { search_plan: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async triagePaperCandidates(
    idea: string,
    candidates: unknown[],
    progress?: (message: string) => void
  ): Promise<{ triage: CandidateTriage; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("02_candidate_triage.md", "Triage paper candidates before novelty judgment.", { idea, candidates }, validateCandidateTriage, "CandidateTriage", progress);
    return { triage: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async readPaperPdf(
    idea: string,
    paper: unknown,
    chunks: unknown[],
    progress?: (message: string) => void
  ): Promise<{ paper_note: PdfPaperNote; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("03_pdf_paper_reader.md", "Read parsed PDF chunks and extract evidence only from the chunks.", { idea, paper, chunks }, validatePdfPaperNote, "PdfPaperNote", progress);
    return { paper_note: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async analyzeRelatedWork(
    idea: string,
    paperNotes: unknown[],
    progress?: (message: string) => void
  ): Promise<{ related_work: RelatedWorkAnalysis; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("04_related_work_analyst.md", "Synthesize verified paper notes into a related-work map.", { idea, paper_notes: paperNotes }, validateRelatedWorkAnalysis, "RelatedWorkAnalysis", progress);
    return { related_work: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async analyzeNovelty(
    idea: string,
    relatedWork: unknown,
    progress?: (message: string) => void
  ): Promise<{ novelty: NoveltyGapAnalysis; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("05_novelty_gap_analyst.md", "Compare the idea against verified related work and identify defensible gaps.", { idea, related_work: relatedWork }, validateNoveltyGapAnalysis, "NoveltyGapAnalysis", progress);
    return { novelty: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async scoreCcfA(
    idea: string,
    evidence: unknown,
    progress?: (message: string) => void
  ): Promise<{ scorecard: StrictCcfAReview; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("06_ccf_a_reviewer.md", "Apply the strict CCF-A evidence rubric and cap rules.", { idea, evidence }, validateStrictCcfAReview, "StrictCcfAReview", progress);
    return { scorecard: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async reviewFeasibility(
    idea: string,
    constraints: unknown,
    progress?: (message: string) => void
  ): Promise<{ feasibility: FeasibilityReview; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("07_feasibility_reviewer.md", "Review feasibility under the provided time and resource constraints.", { idea, constraints }, validateFeasibilityReview, "FeasibilityReview", progress);
    return { feasibility: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async refineIdea(
    idea: string,
    reviewContext: unknown,
    progress?: (message: string) => void
  ): Promise<{ strategy: ResearchStrategy; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const { parsed, events } = await this.runStagedAgent("08_research_strategist.md", "Propose a revised defensible research direction after strict review.", { idea, review_context: reviewContext }, validateResearchStrategy, "ResearchStrategy", progress);
    return { strategy: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async discussIdea(
    idea: string,
    conversation: Array<{ role: string; content: string }> = [],
    progress?: (message: string) => void
  ): Promise<{ turn: IdeaDiscussionTurn; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const prompt = buildDiscussionPrompt(idea, conversation);
    progress?.("Codex OAuth: thinking about clarifying questions");
    const payload = responsesPayload(prompt, discussionInstructions(), this.model(), this.options.reasoningEffort);
    const { parsed, events } = await this.requestStructured(payload, validateIdeaDiscussionTurn, progress);
    return { turn: parsed, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  async suggestProjectName(idea: string, progress?: (message: string) => void): Promise<{ project_name: string; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    progress?.("Codex OAuth: thinking about project name");
    const payload = responsesPayload(buildProjectNamePrompt(idea), projectNameInstructions(), this.model(), this.options.reasoningEffort);
    const { parsed, events } = await this.requestStructured(payload, validateProjectNameSuggestion, progress);
    return { project_name: parsed.project_name, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: OPENAI_CODEX_API_SHAPE, codex_model: this.model(), events };
  }

  private async runStagedAgent<T>(
    promptFile: AgentPromptFile,
    task: string,
    context: unknown,
    parser: (value: unknown) => T,
    schemaName: string,
    progress?: (message: string) => void
  ): Promise<{ parsed: T; events: unknown[] }> {
    progress?.(`Codex OAuth: building ${promptFile} request`);
    const prompt = await buildAgentPrompt({ promptFile, task, context });
    const payload = responsesPayload(prompt, stagedAgentInstructions(schemaName), this.model(), this.options.reasoningEffort);
    return this.requestStructured(payload, parser, progress);
  }

  private async requestStructured<T>(payload: object, parser: (value: unknown) => T, progress?: (message: string) => void): Promise<{ parsed: T; events: unknown[] }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    if (!this.options.fetchImpl) {
      const proxy = configureProxyFromEnv();
      if (proxy.enabled) progress?.(`Network proxy enabled: ${proxySummary(proxy)}`);
    }
    const credentials = await this.requireCredentials();
    const headers = codexHeaders(credentials.access, credentials.accountId, this.options.originator ?? "idea2repo", this.options.sessionId);
    const maxRetries = this.options.maxRetries ?? 3;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await fetchImpl(this.endpoint(), { method: "POST", headers, body: JSON.stringify(payload) });
      if (response.status === 401 || response.status === 403) {
        progress?.("Codex OAuth: refreshing expired credentials");
        const refreshed = await refreshOpenAICodexToken(credentials.refresh);
        await (this.options.storage ?? new AuthStorage()).set(OPENAI_CODEX_PROVIDER_ID, refreshed);
        return new CodexOAuthClient({ ...this.options, maxRetries: 0 }).requestStructured(payload, parser, progress);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const message = friendlyCodexError(response.status, text) || text || response.statusText;
        if (attempt < maxRetries && isRetryableError(response.status, message)) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`Codex OAuth request failed with HTTP ${response.status}: ${message}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const raw = await response.text();
        return parseJsonResponse(raw, parser);
      }
      return parseSseResponse(response, parser, progress);
    }
    throw new Error("Codex OAuth request failed before receiving a response");
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizationUrl(state: string, challenge: string): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "idea2repo");
  return url.toString();
}

function parseAuthorizationInput(input: string, expectedState: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  let parsed: { code?: string; state?: string };
  try {
    const url = new URL(value);
    parsed = { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
  } catch {
    if (value.includes("#")) {
      const [code, state] = value.split("#", 2);
      parsed = { code, state };
    } else if (value.includes("code=")) {
      const params = new URLSearchParams(value);
      parsed = { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
    } else {
      parsed = { code: value };
    }
  }
  if (parsed.state && parsed.state !== expectedState) throw new Error("State mismatch");
  return parsed;
}

async function exchangeAuthorizationCode(code: string, verifier: string): Promise<Omit<OAuthCredentials, "type" | "accountId">> {
  return postToken({
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: OAUTH_REDIRECT_URI
  });
}

async function postToken(data: Record<string, string>): Promise<Omit<OAuthCredentials, "type" | "accountId">> {
  configureProxyFromEnv();
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`OAuth request failed: ${response.status} ${await response.text().catch(() => "")}`);
  const json = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") throw new Error("OAuth token response missing fields");
  return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}

function extractAccountId(token: string): string {
  const payload = decodeJwt(token);
  const accountId = (payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined)?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) throw new Error("Failed to extract accountId from token");
  return accountId;
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type OAuthServer = { close: () => void; cancelWait: () => void; waitForCode: () => Promise<{ code: string } | null> };

async function startLocalOAuthServer(state: string): Promise<OAuthServer> {
  let lastCode: string | null = null;
  let cancelled = false;
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }
      lastCode = code;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<!doctype html><html><body><p>Authentication successful. Return to your terminal to continue.</p></body></html>");
    } catch {
      res.statusCode = 500;
      res.end("Internal error");
    }
  });
  return new Promise((resolvePromise) => {
    server
      .listen(1455, "127.0.0.1", () => resolvePromise(oauthServer(server, () => lastCode, () => cancelled, () => (cancelled = true))))
      .on("error", () => resolvePromise({ close: () => closeServer(server), cancelWait: () => undefined, waitForCode: async () => null }));
  });
}

function oauthServer(server: Server, code: () => string | null, cancelled: () => boolean, cancel: () => void): OAuthServer {
  return {
    close: () => closeServer(server),
    cancelWait: cancel,
    waitForCode: async () => {
      for (let i = 0; i < 600; i += 1) {
        const value = code();
        if (value) return { code: value };
        if (cancelled()) return null;
        await sleep(100);
      }
      return null;
    }
  };
}

function closeServer(server: Server): void {
  try {
    server.close();
  } catch {}
}

function responsesPayload(prompt: string, instructions: string, model: string, reasoningEffort?: string): object {
  return {
    model,
    store: false,
    stream: true,
    instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: "auto" } } : {})
  };
}

function researchInstructions(): string {
  return "You are Idea2Repo's Codex-backed research agent. Return exactly one JSON object and no Markdown, prose, code fence, or citations. The JSON object must validate against the ResearchAnalysis JSON Schema. Do not fabricate papers, BibTeX, datasets, metrics, or experiment results; when evidence needs verification, express it as search queries or verification tasks.";
}

function discussionInstructions(): string {
  return "You are Idea2Repo's Codex-backed research intake agent. Return exactly one JSON object and no Markdown, prose, or code fence. Ask only necessary clarification questions. If enough information is available, set ready_to_analyze to true and include concise visible assumptions.";
}

function projectNameInstructions(): string {
  return "You are naming a local research repository. Return exactly one JSON object with project_name only. The value must be lowercase kebab-case ASCII, 3 to 48 characters, memorable, specific to the idea, and safe as a directory, npm package, and GitHub repo name. Do not include markdown, prose, code fences, paths, or extensions.";
}

export function buildResearchPrompt(idea: string, options: { requestedDomains?: string[]; timelineWeeks?: number; resources?: string[]; stack?: "python" | "ts" } = {}): string {
  return [
    "Generate a strict CCF-A readiness analysis for this research idea.",
    `Idea: ${idea}`,
    `Requested domains: ${(options.requestedDomains ?? []).join(", ") || "auto"}`,
    `Timeline weeks: ${options.timelineWeeks ?? 12}`,
    `Resources: ${(options.resources ?? []).join(", ") || "none"}`,
    `Generated scaffold stack: ${options.stack ?? "python"}`
  ].join("\n");
}

export function buildDiscussionPrompt(idea: string, conversation: Array<{ role: string; content: string }> = []): string {
  return [
    "Collect only the missing information required to generate an Idea2Repo research project.",
    `Initial idea: ${idea}`,
    conversation.map((turn) => `${turn.role}: ${turn.content}`).join("\n")
  ].filter(Boolean).join("\n\n");
}

function buildProjectNamePrompt(idea: string): string {
  return [
    "Suggest one concise project directory name for this research idea.",
    `Idea: ${idea}`,
    "Return JSON: {\"project_name\":\"short-kebab-case-name\"}"
  ].join("\n");
}

function validateProjectNameSuggestion(value: unknown): { project_name: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex project-name response was not an object");
  const projectName = (value as { project_name?: unknown }).project_name;
  if (typeof projectName !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(projectName)) {
    throw new Error("Codex project-name response did not include a safe kebab-case project_name");
  }
  return { project_name: projectName };
}

function resolveCodexResponsesUrl(raw: string): string {
  const normalized = raw.trim().replace(/\/+$/, "") || DEFAULT_CODEX_BASE_URL;
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function usageEndpointCandidates(responsesEndpoint: string): string[] {
  const url = new URL(responsesEndpoint);
  const origin = url.origin;
  return unique([
    `${origin}/backend-api/codex/usage`,
    `${origin}/backend-api/wham/usage`,
    `${origin}/api/codex/usage`,
    `${origin}/wham/usage`
  ]);
}

export function parseUsageSnapshot(raw: unknown, source = "unknown"): CodexUsageSnapshot {
  const snapshot = findUsageSnapshot(raw);
  if (!snapshot) return { available: false, source };
  const primary = normalizeRateLimitWindow(snapshot.primary ?? snapshot.primary_window);
  const secondary = normalizeRateLimitWindow(snapshot.secondary ?? snapshot.secondary_window);
  const credits = normalizeCredits(snapshot.credits);
  return {
    available: true,
    source,
    limitName: stringField(snapshot, "limitName", "limit_name"),
    primary,
    secondary,
    credits,
    planType: stringField(snapshot, "planType", "plan_type"),
    rateLimitReachedType: stringField(snapshot, "rateLimitReachedType", "rate_limit_reached_type")
  };
}

function findUsageSnapshot(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsageSnapshot(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  if (object.rate_limit && typeof object.rate_limit === "object") {
    return {
      ...(object.rate_limit as Record<string, unknown>),
      credits: object.credits,
      plan_type: object.plan_type,
      rate_limit_reached_type: object.rate_limit_reached_type
    };
  }
  if (object.primary || object.secondary || object.primary_window || object.secondary_window || object.limitName || object.limit_name || object.credits) return object;
  for (const item of Object.values(object)) {
    const found = findUsageSnapshot(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeRateLimitWindow(value: unknown): RateLimitWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const seconds = numberField(object, "limitWindowSeconds", "limit_window_seconds", "window_seconds");
  const resetAfterSeconds = numberField(object, "resetAfterSeconds", "reset_after_seconds");
  return {
    usedPercent: numberField(object, "usedPercent", "used_percent"),
    windowMinutes: numberField(object, "windowDurationMins", "windowDurationMinutes", "window_minutes", "window_mins") ?? (seconds == null ? null : Math.round(seconds / 60)),
    resetsAt: timestampField(object, "resetsAt", "resets_at", "resetAt", "reset_at") ?? (resetAfterSeconds == null ? null : Date.now() + resetAfterSeconds * 1000)
  };
}

function normalizeCredits(value: unknown): CreditsSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  return {
    hasCredits: booleanField(object, "hasCredits", "has_credits"),
    unlimited: booleanField(object, "unlimited"),
    balance: numberField(object, "balance")
  };
}

function stringField(object: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = object[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function numberField(object: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = object[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function booleanField(object: Record<string, unknown>, ...names: string[]): boolean | null {
  for (const name of names) {
    const value = object[name];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function timestampField(object: Record<string, unknown>, ...names: string[]): number | null {
  let value: number | null = null;
  for (const name of names) {
    const raw = object[name];
    if (typeof raw === "string" && raw.trim() && !Number.isFinite(Number(raw))) {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  value = numberField(object, ...names);
  if (value == null) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function codexHeaders(token: string, accountId: string, originator: string, sessionId?: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("originator", originator);
  headers.set("User-Agent", `idea2repo (${platform()} ${release()}; ${arch()})`);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (sessionId) headers.set("session_id", sessionId);
  return headers;
}

async function parseJsonResponse<T>(raw: string, parser: (value: unknown) => T): Promise<{ parsed: T; events: unknown[] }> {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const text = typeof payload.output_text === "string" ? payload.output_text : raw;
  return { parsed: parser(JSON.parse(text)), events: [payload] };
}

async function parseSseResponse<T>(response: Response, parser: (value: unknown) => T, progress?: (message: string) => void): Promise<{ parsed: T; events: unknown[] }> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const events: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n").trim();
      if (data && data !== "[DONE]") {
        const event = JSON.parse(data) as Record<string, unknown>;
        events.push(event);
        const eventType = String(event.type ?? event.event ?? "event");
        if (eventType === "error") throw new Error(eventErrorMessage(event));
        if (eventType === "response.failed") throw new Error(responseFailedMessage(event));
        const delta = eventTextDelta(event, eventType);
        if (delta) {
          text += delta;
          progress?.("Codex OAuth: receiving structured analysis");
        }
        const responsePayload = event.response;
        if (!text && responsePayload && typeof responsePayload === "object") {
          const output = responseOutputText(responsePayload as Record<string, unknown>);
          if (output) text += output;
        }
      }
      index = buffer.indexOf("\n\n");
    }
  }
  return { parsed: parser(JSON.parse(text)), events };
}

function eventTextDelta(event: Record<string, unknown>, eventType: string): string {
  if (eventType && !eventType.toLowerCase().endsWith(".delta")) return "";
  return typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : "";
}

function responseOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output
    .flatMap((item) => (item && typeof item === "object" && Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : []))
    .map((content) => (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string" ? (content as { text: string }).text : ""))
    .join("");
}

function eventErrorMessage(event: Record<string, unknown>): string {
  const error = event.error as { type?: unknown; code?: unknown; message?: unknown } | undefined;
  if (error && typeof error === "object") {
    const type = typeof error.type === "string" ? error.type : "";
    const message = typeof error.message === "string" ? error.message : typeof error.code === "string" ? error.code : JSON.stringify(error);
    return `${type ? `Codex ${type}` : "Codex error"}: ${message}`;
  }
  return String(event.message ?? `Codex error: ${JSON.stringify(event)}`);
}

function responseFailedMessage(event: Record<string, unknown>): string {
  const response = event.response as { error?: { message?: string; code?: string; type?: string } } | undefined;
  const error = response?.error;
  if (error?.message && (error.code || error.type)) return `${error.message} (${error.code ?? error.type})`;
  return error?.message ?? "Codex response failed";
}

function friendlyCodexError(status: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number } };
    const error = parsed.error;
    const code = error?.code ?? error?.type ?? "";
    if (status === 429 || /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code)) {
      const plan = error?.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
      const retry = error?.resets_at ? ` Try again in ~${Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60000))} min.` : "";
      return `You have hit your ChatGPT usage limit${plan}.${retry}`.trim();
    }
    return error?.message ?? "";
  } catch {
    return "";
  }
}

function isRetryableError(status: number, message: string): boolean {
  return [429, 500, 502, 503, 504].includes(status) || /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
