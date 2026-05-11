import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildGithubExportPlan } from "./github-export.js";
import { generateResearchRepo, resumeResearchRepo, type GenerateOptions } from "./generator.js";
import { paperCandidateToRecord, searchLiteratureAsync } from "./literature.js";
import { safeProviderReport, providerSchema } from "./providers.js";
import { diagnoseIdea } from "./scoring.js";
import { status as projectStatus, validate as validateProject } from "./state.js";
import { submissionReady, blockingReasons } from "./evidence.js";
import { runWorkflow } from "./workflow.js";
import { openaiCodexOAuthProvider } from "./auth/codex-oauth.js";
import { loadCodexModelCatalog } from "./models.js";
import { readApprovalRecords, resolveApprovalRecord } from "./runtime/approvals.js";
import { readDecisionRecords } from "./runtime/decisions.js";
import { readPlanState } from "./runtime/plan.js";
import { isFinalStatus, retryRuntimeStage, RunManager, skipRuntimeStage, type RuntimeRunRecord } from "./runtime/runs.js";
import type { Idea2RepoEvent } from "./runtime/events.js";
import type { ResearchStageId } from "./pipeline/stages.js";

export type ApiServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

type JsonValue = Record<string, unknown> | unknown[];

const defaultRunManager = new RunManager();

export function createApiHandler(options: { runManager?: RunManager } = {}) {
  const runManager = options.runManager ?? defaultRunManager;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      await route(request, response, runManager);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      sendJson(response, statusCode, { detail: error instanceof Error ? error.message : "unknown error" });
    }
  };
}

export async function startApiServer(options: { host?: string; port?: number } = {}): Promise<ApiServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8000;
  const server = createServer(createApiHandler());
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())))
  };
}

async function route(request: IncomingMessage, response: ServerResponse, runManager: RunManager): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }
  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { ok: true, service: "idea2repo", runtime: "node" });
    return;
  }
  if (request.method === "GET" && (path === "/provider" || path === "/provider/settings")) {
    const status = await openaiCodexOAuthProvider.status();
    sendJson(response, 200, {
      provider: "openai-codex",
      schema: providerSchema(),
      report: safeProviderReport("openai-codex"),
      model_catalog: loadCodexModelCatalog(),
      auth: status
    });
    return;
  }
  if (request.method === "GET" && path === "/runs") {
    sendJson(response, 200, { runs: runManager.list() });
    return;
  }
  const runMatch = /^\/runs\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (request.method === "GET" && runMatch) {
    const run = requiredRun(runManager, decodeURIComponent(runMatch[1]!));
    const suffix = runMatch[2] ?? "";
    if (!suffix) {
      sendJson(response, 200, runSnapshot(run));
      return;
    }
    if (suffix === "events") {
      sendSse(response, runManager, run);
      return;
    }
    if (suffix === "plan") {
      sendJson(response, 200, { run_id: run.id, plan: await readPlanState(run.output_root) });
      return;
    }
    if (suffix === "decisions") {
      sendJson(response, 200, { run_id: run.id, decisions: await readDecisionRecords(run.output_root).catch(() => []) });
      return;
    }
    if (suffix === "artifacts") {
      const artifacts = await artifactEntries(run.output_root);
      sendJson(response, 200, { run_id: run.id, root: run.output_root, artifacts, tree: artifactTree(artifacts) });
      return;
    }
    if (suffix === "approvals") {
      sendJson(response, 200, { run_id: run.id, approvals: await readApprovalRecords(run.output_root) });
      return;
    }
    throw new HttpError(404, "route not found");
  }
  if (request.method !== "POST") throw new HttpError(404, "route not found");
  const body = (await readJson(request)) as Record<string, unknown>;
  if (path === "/runs") {
    const idea = requiredString(body.idea, "idea");
    const output = resolve(requiredString(body.output, "output"));
    const run = runManager.start({ idea, outputRoot: output }, async ({ runId, events, signal }) => {
      const result = await generateResearchRepo(idea, output, {
        ...generateOptionsFromBody(body),
        runResearchPipeline: body.run_research_pipeline !== false,
        jsonlEvents: body.jsonl_events !== false,
        runId,
        eventSink: events,
        signal,
        permissionPolicy: {
          allowWrite: true,
          allowOverwrite: Boolean(body.force),
          allowNetwork: Boolean(body.allow_network),
          allowLogin: false,
          allowInstall: false,
          allowPublish: false
        }
      });
      return {
        root: result.root,
        project_name: result.project_name,
        analysis_source: result.analysis_source,
        fallback_reason: result.fallback_reason
      };
    });
    sendJson(response, 202, {
      run_id: run.id,
      status: run.status,
      output_root: run.output_root,
      events_url: `/runs/${encodeURIComponent(run.id)}/events`,
      plan_url: `/runs/${encodeURIComponent(run.id)}/plan`,
      decisions_url: `/runs/${encodeURIComponent(run.id)}/decisions`,
      artifacts_url: `/runs/${encodeURIComponent(run.id)}/artifacts`
    });
    return;
  }
  const runActionMatch = /^\/runs\/([^/]+)\/(.+)$/.exec(path);
  if (runActionMatch) {
    const run = requiredRun(runManager, decodeURIComponent(runActionMatch[1]!));
    const suffix = runActionMatch[2] ?? "";
    if (suffix === "cancel") {
      const cancelled = await runManager.cancel(run.id, stringOrNull(body.reason) ?? "cancel requested from API");
      sendJson(response, 202, { run_id: run.id, status: cancelled?.status ?? run.status });
      return;
    }
    const stageAction = /^stages\/([^/]+)\/(retry|skip)$/.exec(suffix);
    if (stageAction) {
      const stageId = decodeURIComponent(stageAction[1]!) as ResearchStageId;
      if (stageAction[2] === "retry") {
        const result = await retryRuntimeStage(run.output_root, stageId, {
          runId: run.id,
          reason: stringOrNull(body.reason) ?? undefined,
          execute: body.execute !== false,
          allowNetwork: Boolean(body.allow_network),
          downloadPdfs: Boolean(body.download_pdfs),
          maxPapers: numberValue(body.max_papers, 20)
        });
        sendJson(response, 200, result as unknown as Record<string, unknown>);
        return;
      }
      const result = await skipRuntimeStage(run.output_root, stageId, requiredString(body.reason, "reason"), { runId: run.id });
      sendJson(response, 200, result as unknown as Record<string, unknown>);
      return;
    }
    const approvalAction = /^approvals\/([^/]+)$/.exec(suffix);
    if (approvalAction) {
      const decision = body.decision === "approved" ? "approved" : body.decision === "denied" ? "denied" : null;
      if (!decision) throw new HttpError(400, "decision must be approved or denied");
      const record = await resolveApprovalRecord(run.output_root, decodeURIComponent(approvalAction[1]!), decision, { reason: stringOrNull(body.reason) ?? undefined });
      sendJson(response, 200, record as unknown as Record<string, unknown>);
      return;
    }
  }
  if (path === "/generate") {
    const result = await generateResearchRepo(requiredString(body.idea, "idea"), requiredString(body.output, "output"), {
      ...generateOptionsFromBody(body),
      permissionPolicy: {
        allowWrite: true,
        allowOverwrite: Boolean(body.force),
        allowNetwork: Boolean(body.allow_network),
        allowLogin: false,
        allowInstall: false,
        allowPublish: false
      }
    });
    sendJson(response, 200, {
      root: result.root,
      project_name: result.project_name,
      primary_route: result.diagnosis.routes[0]?.domain.key,
      raw_score: result.diagnosis.raw_score.total,
      revised_score: result.diagnosis.revised_score.total,
      evidence_gate: evidencePayload(result.diagnosis.evidence_gate),
      security: result.diagnosis.security_assessment,
      analysis_source: result.analysis_source,
      codex_available: result.codex_available,
      codex_logged_in: result.codex_logged_in,
      codex_model: result.model,
      fallback_reason: result.fallback_reason,
      research_pipeline_stages: result.research_pipeline?.state.stages.length,
      template_profile_id: result.template_profile_id
    });
    return;
  }
  if (path === "/status") {
    sendJson(response, 200, await projectStatus(requiredString(body.output, "output")));
    return;
  }
  if (path === "/resume") {
    const result = await resumeResearchRepo(requiredString(body.output, "output"), { force: Boolean(body.force) });
    sendJson(response, 200, {
      root: result.root,
      restored_files: result.files.map((file) => toPosix(relative(result.root, file))).filter((file) => !file.startsWith(".."))
    });
    return;
  }
  if (path === "/validate") {
    const errors = await validateProject(requiredString(body.output, "output"));
    sendJson(response, 200, { ok: errors.length === 0, errors });
    return;
  }
  if (path === "/artifacts") {
    const root = await existingRoot(requiredString(body.output, "output"));
    const artifacts = await artifactEntries(root);
    sendJson(response, 200, { root, artifacts, tree: artifactTree(artifacts) });
    return;
  }
  if (path === "/artifacts/read") {
    const root = await existingRoot(requiredString(body.output, "output"));
    const path = safeChild(root, requiredString(body.path, "path"));
    const pathStat = await stat(path).catch(() => null);
    if (!pathStat?.isFile()) throw new HttpError(404, "artifact not found");
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch {
      throw new HttpError(415, "artifact is not UTF-8 text");
    }
    sendJson(response, 200, { path: toPosix(relative(root, path)), bytes: pathStat.size, content });
    return;
  }
  if (path === "/literature/search") {
    const result = await searchLiteratureAsync({
      query: requiredString(body.query, "query"),
      allowNetwork: Boolean(body.allow_network),
      limit: numberValue(body.limit, 10)
    });
    sendJson(response, 200, {
      candidates: result.candidates,
      warnings: result.warnings,
      search_report: result.search_report,
      records: result.candidates.map((candidate, index) => paperCandidateToRecord(candidate, index)),
      tasks: result.warnings
    });
    return;
  }
  if (path === "/score") {
    const diagnosis = diagnoseIdea(requiredString(body.idea, "idea"), { requestedDomains: stringArray(body.domains) });
    sendJson(response, 200, {
      primary_route: diagnosis.routes[0]?.domain.key,
      raw_score: diagnosis.raw_score.total,
      revised_score: diagnosis.revised_score.total,
      evidence_gate: evidencePayload(diagnosis.evidence_gate),
      security: diagnosis.security_assessment,
      required_evidence: diagnosis.required_evidence
    });
    return;
  }
  if (path === "/reviewer/simulate" || path === "/reviewer") {
    const diagnosis = diagnoseIdea(requiredString(body.idea, "idea"), { requestedDomains: stringArray(body.domains) });
    const artifacts = runWorkflow(diagnosis);
    sendJson(response, 200, {
      artifact: "docs/workflow/reviewer_simulation.md",
      content: artifacts["docs/workflow/reviewer_simulation.md"]
    });
    return;
  }
  if (path === "/rebuttal") {
    const diagnosis = diagnoseIdea(stringOrNull(body.idea) || "local research idea", { requestedDomains: stringArray(body.domains) });
    const artifacts = runWorkflow(diagnosis);
    const reviews = stringArray(body.reviews);
    sendJson(response, 200, {
      artifact: "docs/workflow/rebuttal_plan.md",
      review_count: reviews.filter((review) => review.trim()).length,
      content: artifacts["docs/workflow/rebuttal_plan.md"],
      clusters: reviewClusters(reviews)
    });
    return;
  }
  if (path === "/provider/settings") {
    const status = await openaiCodexOAuthProvider.status();
    sendJson(response, 200, { provider: "openai-codex", schema: providerSchema(), report: safeProviderReport("openai-codex"), model_catalog: loadCodexModelCatalog(), auth: status });
    return;
  }
  if (path === "/github/dry-run") {
    sendJson(
      response,
      200,
      await buildGithubExportPlan(requiredString(body.output, "output"), {
        repoName: stringOrNull(body.repo_name) ?? undefined,
        createIssues: body.create_issues !== false
      })
    );
    return;
  }
  throw new HttpError(404, "route not found");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: JsonValue | Record<string, unknown>): void {
  const body = statusCode === 204 ? "" : `${JSON.stringify(payload)}\n`;
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.end(body);
}

function sendSse(response: ServerResponse, runManager: RunManager, run: RuntimeRunRecord): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("access-control-allow-origin", "*");
  for (const event of run.events) writeSseEvent(response, event);
  if (isFinalStatus(run.status)) {
    response.end();
    return;
  }
  const unsubscribe = runManager.subscribe(run.id, (event) => {
    writeSseEvent(response, event);
    const current = runManager.get(run.id);
    if (current && isFinalStatus(current.status)) {
      unsubscribe?.();
      response.end();
    }
  });
  if (!unsubscribe) response.end();
}

function writeSseEvent(response: ServerResponse, event: Idea2RepoEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function runSnapshot(run: RuntimeRunRecord): Record<string, unknown> {
  const { events: _events, ...snapshot } = run;
  return snapshot;
}

function requiredRun(runManager: RunManager, runId: string): RuntimeRunRecord {
  const run = runManager.get(runId);
  if (!run) throw new HttpError(404, "run not found");
  return run;
}

function generateOptionsFromBody(body: Record<string, unknown>): GenerateOptions {
  return {
    requestedDomains: stringArray(body.domains),
    timelineWeeks: numberValue(body.weeks, 12),
    resources: stringArray(body.resources),
    stack: body.stack === "ts" ? "ts" : "python",
    force: Boolean(body.force),
    offline: Boolean(body.offline),
    provider: stringOrNull(body.provider),
    model: stringOrNull(body.model),
    reasoningEffort: stringOrNull(body.reasoning_effort),
    runResearchPipeline: Boolean(body.run_research_pipeline),
    allowNetwork: Boolean(body.allow_network),
    downloadPdfs: Boolean(body.download_pdfs),
    maxPapers: numberValue(body.max_papers, 20),
    sources: stringArray(body.sources),
    strictCcfA: Boolean(body.strict_ccf_a),
    venue: stringOrNull(body.venue) ?? undefined,
    template: stringOrNull(body.template) ?? undefined,
    reviewMode: reviewModeValue(body.review_mode),
    paperType: paperTypeValue(body.paper_type),
    templateYear: optionalNumberValue(body.template_year),
    compilePaper: Boolean(body.compile_paper),
    packageOverleaf: Boolean(body.package_overleaf)
  };
}

async function existingRoot(output: string): Promise<string> {
  const root = resolve(output);
  const pathStat = await stat(root).catch(() => null);
  if (!pathStat?.isDirectory()) throw new HttpError(404, "output not found");
  return root;
}

function safeChild(root: string, relativePath: string): string {
  const child = resolve(root, relativePath);
  const rel = relative(root, child);
  if (!rel || rel.startsWith("..") || resolve(rel) === rel) throw new HttpError(400, "path escapes output root");
  return child;
}

async function artifactEntries(root: string): Promise<Array<{ path: string; bytes: number; text: boolean }>> {
  const entries: Array<{ path: string; bytes: number; text: boolean }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const pathStat = await stat(path);
        entries.push({ path: toPosix(relative(root, path)), bytes: pathStat.size, text: await looksText(path) });
      }
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function artifactTree(entries: Array<{ path: string; bytes: number; text: boolean }>): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let cursor: Record<string, unknown> = tree;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (!next || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = { bytes: entry.bytes, text: entry.text };
  }
  return tree;
}

async function looksText(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

function evidencePayload(gate: Parameters<typeof submissionReady>[0]): Record<string, unknown> {
  return {
    submission_ready: submissionReady(gate),
    status: submissionReady(gate) ? "ready" : "blocked",
    blocking_reasons: blockingReasons(gate)
  };
}

function reviewClusters(reviews: string[]): Record<string, string[]> {
  const clusters: Record<string, string[]> = {
    novelty: [],
    soundness: [],
    significance: [],
    reproducibility: [],
    ethics: [],
    other: []
  };
  for (const review of reviews) {
    const lowered = review.toLowerCase();
    const key = lowered.includes("novel") ? "novelty" : lowered.includes("sound") || lowered.includes("experiment") ? "soundness" : lowered.includes("significance") || lowered.includes("impact") ? "significance" : lowered.includes("reproduc") ? "reproducibility" : lowered.includes("ethic") || lowered.includes("privacy") ? "ethics" : "other";
    clusters[key]!.push(review);
  }
  return clusters;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function reviewModeValue(value: unknown): "anonymous" | "camera-ready" | "non-anonymous" | undefined {
  return value === "anonymous" || value === "camera-ready" || value === "non-anonymous" ? value : undefined;
}

function paperTypeValue(value: unknown): "full" | "short" | "demo" | "dataset" | "system" | "benchmark" | undefined {
  return value === "full" || value === "short" || value === "demo" || value === "dataset" || value === "system" || value === "benchmark" ? value : undefined;
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}
