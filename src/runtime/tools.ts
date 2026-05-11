import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildGithubExportPlan, publishWithGh } from "../github-export.js";
import { searchLiteratureAsync, type LiteratureSearchOptions, type LiteratureSearchResult } from "../literature.js";
import { strictCcfAScore, type StrictScoreInput, type StrictScoreResult } from "../skills/analysis/ccf-a-score.js";
import { extractEvidenceRows, type ClaimEvidenceRow } from "../skills/analysis/evidence-extract.js";
import { acquirePdfs, type PdfAcquireOptions } from "../skills/pdf/acquire.js";
import { buildPdfChunkIndex, type PdfChunkIndexEntry } from "../skills/pdf/chunk.js";
import type { PdfManifestRecord } from "../skills/pdf/provenance.js";
import type { PaperCandidate } from "../skills/literature/types.js";
import { checkTemplateCompliance, checkTemplateComplianceArtifacts } from "../skills/templates/compliance.js";
import { resolveTemplateProfile } from "../skills/templates/resolve.js";
import { renderPaper } from "../skills/templates/render.js";
import type { PaperRenderInput, PaperRenderResult, TemplateComplianceResult, TemplateResolveInput, TemplateResolveResult, VenueTemplateProfile } from "../skills/templates/types.js";
import { ensureChild, exists } from "../state.js";
import { refreshManifestArtifactHashes, snapshotArtifact } from "./artifacts.js";
import { DecisionRecorder, type DecisionInput } from "./decisions.js";
import { runtimeTimestamp, type EventSink } from "./events.js";
import { writePlanState, type PlanState } from "./plan.js";
import {
  ApprovalRecorder,
  approvalPolicyForMode,
  enforceApproval,
  type ApprovalPolicy,
  type ApprovalRisk
} from "./approvals.js";

export const TOOL_CALLS_PATH = join(".idea2repo", "tool_calls.jsonl");

export type ToolRisk = ApprovalRisk | "write-state";

export type ToolContext = {
  runId: string;
  outputRoot: string;
  events: EventSink;
  permissions: ApprovalPolicy;
  approvals?: ApprovalRecorder;
  toolCalls?: ToolCallRecorder;
};

export type ToolSpec<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  risk: ToolRisk[] | ((input: Input, ctx: ToolContext) => Promise<ToolRisk[]> | ToolRisk[]);
  inputSchema: object;
  outputSchema?: object;
  handler: (input: Input, ctx: ToolContext) => Promise<Output>;
  summarizeInput?: (input: Input) => string;
  summarizeOutput?: (output: Output) => string;
};

export type ToolCallRecord = {
  id: string;
  run_id: string;
  tool_name: string;
  risk: ToolRisk[];
  status: "started" | "completed" | "failed";
  input_summary: string;
  summary?: string;
  error?: string;
  started_at: string;
  completed_at?: string;
};

export class ToolCallRecorder {
  constructor(private readonly root: string) {}

  async record(record: ToolCallRecord): Promise<void> {
    const path = join(this.root, TOOL_CALLS_PATH);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec<any, any>>();

  register<Input, Output>(spec: ToolSpec<Input, Output>): void {
    if (this.specs.has(spec.name)) throw new Error(`tool already registered: ${spec.name}`);
    this.specs.set(spec.name, spec);
  }

  list(): ToolSpec[] {
    return [...this.specs.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async execute<Input, Output>(name: string, input: Input, ctx: ToolContext): Promise<Output> {
    const spec = this.specs.get(name) as ToolSpec<Input, Output> | undefined;
    if (!spec) throw new Error(`unknown tool: ${name}`);
    const risk = typeof spec.risk === "function" ? await spec.risk(input, ctx) : spec.risk;
    const startedAt = runtimeTimestamp();
    const toolCallId = randomUUID();
    const inputSummary = spec.summarizeInput?.(input) ?? summarizeUnknown(input);
    const started: ToolCallRecord = {
      id: toolCallId,
      run_id: ctx.runId,
      tool_name: spec.name,
      risk: [...risk],
      status: "started",
      input_summary: inputSummary,
      started_at: startedAt
    };
    await ctx.toolCalls?.record(started);
    await ctx.events.emit({ type: "tool.started", run_id: ctx.runId, tool_call_id: toolCallId, tool_name: spec.name, timestamp: startedAt });
    try {
      await enforceApproval(ctx.permissions, { run_id: ctx.runId, action: `tool:${spec.name}`, risk: approvalRisks(risk) }, ctx.approvals);
      const output = await spec.handler(input, ctx);
      const summary = spec.summarizeOutput?.(output) ?? `${spec.name} completed`;
      const completedAt = runtimeTimestamp();
      await ctx.toolCalls?.record({ ...started, status: "completed", summary, completed_at: completedAt });
      await ctx.events.emit({ type: "tool.completed", run_id: ctx.runId, tool_call_id: toolCallId, success: true, summary, timestamp: completedAt });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = runtimeTimestamp();
      await ctx.toolCalls?.record({ ...started, status: "failed", error: message, completed_at: completedAt });
      await ctx.events.emit({ type: "tool.completed", run_id: ctx.runId, tool_call_id: toolCallId, success: false, summary: message, timestamp: completedAt });
      throw error;
    }
  }
}

export function createToolContext(options: {
  runId: string;
  outputRoot: string;
  events?: EventSink;
  permissions?: ApprovalPolicy;
  approvals?: ApprovalRecorder;
  toolCalls?: ToolCallRecorder;
  recordToolCalls?: boolean;
}): ToolContext {
  const permissions = options.permissions ?? approvalPolicyForMode("generate");
  return {
    runId: options.runId,
    outputRoot: options.outputRoot,
    events: options.events ?? noopEvents,
    permissions,
    approvals: options.approvals,
    toolCalls: options.recordToolCalls === false ? undefined : options.toolCalls ?? new ToolCallRecorder(options.outputRoot)
  };
}

export function createCoreToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register<{ path: string }, { path: string; content: string; bytes: number }>({
    name: "artifact.read",
    description: "Read a generated repository artifact.",
    risk: ["read"],
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    outputSchema: { type: "object", required: ["path", "content", "bytes"] },
    summarizeInput: (input) => `path=${input.path}`,
    summarizeOutput: (output) => `read ${output.path} (${output.bytes} bytes)`,
    async handler(input, ctx) {
      const path = ensureChild(ctx.outputRoot, input.path);
      const content = await readFile(path, "utf8");
      return { path: input.path, content, bytes: Buffer.byteLength(content) };
    }
  });

  registry.register<ArtifactWriteInput, ArtifactWriteOutput>({
    name: "artifact.write",
    description: "Write a generated repository artifact.",
    risk: async (input, ctx) => ((await exists(ensureChild(ctx.outputRoot, input.path))) ? ["write", "overwrite"] : ["write"]),
    inputSchema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
    outputSchema: { type: "object", required: ["path", "bytes", "sha256"] },
    summarizeInput: (input) => `path=${input.path}; bytes=${Buffer.byteLength(input.content, input.encoding ?? "utf8")}`,
    summarizeOutput: (output) => `wrote ${output.path} (${output.bytes} bytes)`,
    async handler(input, ctx) {
      const path = ensureChild(ctx.outputRoot, input.path);
      const content = Buffer.from(input.content, input.encoding ?? "utf8");
      await snapshotArtifact(ctx.outputRoot, input.path, { runId: ctx.runId, events: ctx.events });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      await refreshManifestArtifactHashes(ctx.outputRoot, [input.path]);
      await ctx.events.emit({ type: "artifact.written", run_id: ctx.runId, path: input.path, sha256, bytes: content.byteLength, timestamp: runtimeTimestamp() });
      return { path: input.path, bytes: content.byteLength, sha256 };
    }
  });

  registry.register<ArtifactAdoptInput, ArtifactWriteOutput>({
    name: "artifact.adopt",
    description: "Record a generated artifact produced by a specialized helper.",
    risk: ["write-state"],
    inputSchema: { type: "object", required: ["path", "bytes", "sha256"], properties: { path: { type: "string" }, bytes: { type: "number" }, sha256: { type: "string" } } },
    outputSchema: { type: "object", required: ["path", "bytes", "sha256"] },
    summarizeInput: (input) => `path=${input.path}; bytes=${input.bytes}`,
    summarizeOutput: (output) => `adopted ${output.path} (${output.bytes} bytes)`,
    async handler(input, ctx) {
      ensureChild(ctx.outputRoot, input.path);
      await refreshManifestArtifactHashes(ctx.outputRoot, [input.path]);
      await ctx.events.emit({ type: "artifact.written", run_id: ctx.runId, path: input.path, sha256: input.sha256, bytes: input.bytes, timestamp: runtimeTimestamp() });
      return { path: input.path, bytes: input.bytes, sha256: input.sha256 };
    }
  });

  registry.register<{ state: PlanState }, { path: string; items: number }>({
    name: "plan.update",
    description: "Persist a live runtime plan state.",
    risk: ["write-state"],
    inputSchema: { type: "object", required: ["state"] },
    outputSchema: { type: "object", required: ["path", "items"] },
    summarizeInput: (input) => `items=${input.state.items.length}`,
    summarizeOutput: (output) => `plan updated with ${output.items} items`,
    async handler(input, ctx) {
      const path = await writePlanState(ctx.outputRoot, input.state);
      return { path, items: input.state.items.length };
    }
  });

  registry.register<DecisionInput, { id: string; title: string }>({
    name: "decision.record",
    description: "Record a visible decision summary.",
    risk: ["write-state"],
    inputSchema: { type: "object", required: ["title", "rationale_summary"] },
    outputSchema: { type: "object", required: ["id", "title"] },
    summarizeInput: (input) => `title=${input.title}`,
    summarizeOutput: (output) => `decision recorded: ${output.title}`,
    async handler(input, ctx) {
      const record = await new DecisionRecorder(ctx.outputRoot, ctx.runId, ctx.events).record(input);
      return { id: record.id, title: record.title };
    }
  });

  registry.register<LiteratureSearchOptions, LiteratureSearchResult>({
    name: "literature.search",
    description: "Search literature candidates through configured sources.",
    risk: (input) => input.allowNetwork ? ["read", "network"] : ["read"],
    inputSchema: { type: "object", required: ["queries"], properties: { queries: { type: "array" }, allowNetwork: { type: "boolean" }, limit: { type: "number" } } },
    summarizeInput: (input) => `queries=${(input.queries ?? (input.query ? [input.query] : [])).length}; allow_network=${Boolean(input.allowNetwork)}; limit=${input.limit ?? "default"}`,
    summarizeOutput: (output) => `candidates=${output.candidates.length}; warnings=${output.warnings.length}`,
    handler: (input) => searchLiteratureAsync(input)
  });

  registry.register<PdfAcquireToolInput, PdfManifestRecord[]>({
    name: "pdf.acquire",
    description: "Acquire public PDFs and write validated downloads into the generated repository.",
    risk: (input) => [
      "read",
      ...(input.downloadPdfs ? ["write" as const] : []),
      ...(input.allowNetwork && input.downloadPdfs ? ["network" as const] : [])
    ],
    inputSchema: { type: "object", required: ["candidates", "outputRoot"], properties: { candidates: { type: "array" }, outputRoot: { type: "string" }, allowNetwork: { type: "boolean" }, downloadPdfs: { type: "boolean" } } },
    summarizeInput: (input) => `candidates=${input.candidates.length}; download_pdfs=${Boolean(input.downloadPdfs)}; allow_network=${Boolean(input.allowNetwork)}`,
    summarizeOutput: (output) => `pdf_records=${output.length}; downloaded=${output.filter((record) => record.status === "downloaded").length}`,
    handler: (input) => acquirePdfs(input.candidates, input)
  });

  registry.register<{ root: string; manifest: PdfManifestRecord[] }, PdfChunkIndexEntry[]>({
    name: "pdf.chunk",
    description: "Build a stable chunk index from validated PDF manifest records.",
    risk: ["read"],
    inputSchema: { type: "object", required: ["root", "manifest"], properties: { root: { type: "string" }, manifest: { type: "array" } } },
    summarizeInput: (input) => `manifest_records=${input.manifest.length}`,
    summarizeOutput: (output) => `chunks=${output.length}`,
    handler: (input) => buildPdfChunkIndex(input.root, input.manifest)
  });

  registry.register<{ chunks: PdfChunkIndexEntry[] }, ClaimEvidenceRow[]>({
    name: "evidence.extract",
    description: "Extract claim-evidence rows from PDF chunks.",
    risk: ["read"],
    inputSchema: { type: "object", required: ["chunks"], properties: { chunks: { type: "array" } } },
    summarizeInput: (input) => `chunks=${input.chunks.length}`,
    summarizeOutput: (output) => `evidence_rows=${output.length}; verified=${output.filter((row) => row.status === "verified").length}`,
    handler: (input) => Promise.resolve(extractEvidenceRows(input.chunks))
  });

  registry.register<StrictScoreInput, StrictScoreResult>({
    name: "ccf_a.score",
    description: "Apply strict CCF-A readiness scoring caps.",
    risk: ["read"],
    inputSchema: { type: "object" },
    summarizeInput: (input) => `verified_related_work=${input.verifiedRelatedWorkCount ?? 0}; pdf_read=${input.pdfReadCount ?? 0}; collision=${Boolean(input.highPriorWorkCollision)}`,
    summarizeOutput: (output) => `strict_score=${output.total}; caps=${output.caps.length}`,
    handler: (input) => Promise.resolve(strictCcfAScore(input))
  });

  registry.register<TemplateResolveInput, TemplateResolveResult>({
    name: "template.resolve",
    description: "Resolve the venue-aware paper template profile.",
    risk: ["read"],
    inputSchema: { type: "object", properties: { venue: { type: "string" }, domain: { type: "string" }, family: { type: "string" }, year: { type: "number" }, mode: { type: "string" }, paperType: { type: "string" } } },
    summarizeInput: (input) => `venue=${input.venue ?? "auto"}; domain=${input.domain ?? "auto"}; family=${input.family ?? "auto"}`,
    summarizeOutput: (output) => `profile=${output.profile.profile_id}; confidence=${output.confidence}`,
    handler: (input) => resolveTemplateProfile(input)
  });

  registry.register<PaperRenderInput, PaperRenderResult>({
    name: "template.render",
    description: "Render a paper scaffold from a resolved template profile.",
    risk: ["write"],
    inputSchema: { type: "object", required: ["profile", "projectName", "title", "anonymous"], properties: { profile: { type: "object" }, projectName: { type: "string" }, title: { type: "string" }, anonymous: { type: "boolean" }, reviewMode: { type: "string" } } },
    summarizeInput: (input) => `profile=${input.profile.profile_id}; review_mode=${input.reviewMode ?? (input.anonymous ? "anonymous" : "non_anonymous")}`,
    summarizeOutput: (output) => `rendered_files=${Object.keys(output.files).length}; warnings=${output.warnings.length}`,
    handler: (input) => Promise.resolve(renderPaper(input))
  });

  registry.register<TemplateCheckInput, TemplateComplianceResult>({
    name: "template.check",
    description: "Run static paper template and anonymity compliance checks.",
    risk: (input) => (input.artifacts ? ["read"] : ["read", "write-state"]),
    inputSchema: { type: "object", required: ["profile"], properties: { profile: { type: "object" }, anonymous: { type: "boolean" }, strict: { type: "boolean" }, artifacts: { type: "object" } } },
    summarizeInput: (input) => `profile=${input.profile.profile_id}; anonymous=${Boolean(input.anonymous)}; artifacts=${input.artifacts ? Object.keys(input.artifacts).length : "filesystem"}`,
    summarizeOutput: (output) => `status=${output.status}; errors=${output.errors.length}; warnings=${output.warnings.length}`,
    handler: (input, ctx) =>
      input.artifacts
        ? Promise.resolve(checkTemplateComplianceArtifacts(input.artifacts, input))
        : checkTemplateCompliance(ctx.outputRoot, input)
  });

  registry.register<{ repoName?: string; createIssues?: boolean }, Awaited<ReturnType<typeof buildGithubExportPlan>>>({
    name: "github.dry_run",
    description: "Build GitHub publish payloads without network publication.",
    risk: ["read"],
    inputSchema: { type: "object", properties: { repoName: { type: "string" }, createIssues: { type: "boolean" } } },
    summarizeInput: (input) => `repo=${input.repoName ?? "auto"}`,
    summarizeOutput: (output) => `dry-run for ${output.repo_name}: ${output.would_create_issues} issues`,
    handler: (input, ctx) => buildGithubExportPlan(ctx.outputRoot, { repoName: input.repoName, createIssues: input.createIssues })
  });

  registry.register<{ repoName?: string; createIssues?: boolean }, Awaited<ReturnType<typeof publishWithGh>>>({
    name: "github.publish",
    description: "Publish the generated repository through GitHub CLI.",
    risk: ["write", "network", "publish"],
    inputSchema: { type: "object", properties: { repoName: { type: "string" }, createIssues: { type: "boolean" } } },
    summarizeInput: (input) => `repo=${input.repoName ?? "auto"}`,
    summarizeOutput: (output) => `published ${output.repo_name}`,
    async handler(input, ctx) {
      const plan = await buildGithubExportPlan(ctx.outputRoot, { repoName: input.repoName, createIssues: input.createIssues });
      return publishWithGh(plan, {
        approvalPolicy: ctx.permissions,
        approvalRecorder: ctx.approvals,
        permissionPolicy: {
          allowWrite: ctx.permissions.allowWrite,
          allowOverwrite: ctx.permissions.allowOverwrite,
          allowNetwork: ctx.permissions.allowNetwork,
          allowLogin: false,
          allowInstall: false,
          allowPublish: ctx.permissions.allowPublish
        }
      });
    }
  });

  return registry;
}

export async function readToolCallRecords(root: string): Promise<ToolCallRecord[]> {
  let raw = "";
  try {
    raw = await readFile(join(root, TOOL_CALLS_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ToolCallRecord);
}

export type ArtifactWriteInput = {
  path: string;
  content: string;
  encoding?: BufferEncoding;
};

export type ArtifactWriteOutput = {
  path: string;
  bytes: number;
  sha256: string;
};

export type ArtifactAdoptInput = ArtifactWriteOutput;

export type PdfAcquireToolInput = PdfAcquireOptions & {
  candidates: PaperCandidate[];
};

export type TemplateCheckInput = {
  profile: VenueTemplateProfile;
  anonymous?: boolean;
  strict?: boolean;
  artifacts?: Record<string, string>;
};

function approvalRisks(risk: ToolRisk[]): ApprovalRisk[] {
  return [...new Set(risk.map((item) => (item === "write-state" ? "write" : item)))];
}

function summarizeUnknown(value: unknown): string {
  if (value && typeof value === "object") return `keys=${Object.keys(value).sort().join(",")}`;
  return typeof value;
}

const noopEvents: EventSink = {
  emit() {
    return undefined;
  }
};
