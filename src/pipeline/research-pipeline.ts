import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CandidateTriageSchema,
  FeasibilityReviewSchema,
  IdeaBriefSchema,
  NoveltyGapAnalysisSchema,
  PdfPaperNoteSchema,
  RelatedWorkAnalysisSchema,
  ResearchStrategySchema,
  SearchPlanSchema,
  StrictCcfAReviewSchema,
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
import { CodexOAuthClient } from "../auth/codex-oauth.js";
import { paperCandidateToRecord, referencesBib, type LiteratureSearchOptions, type LiteratureSearchResult, type PaperRecord } from "../literature.js";
import { diagnoseIdea } from "../scoring.js";
import { exists } from "../state.js";
import { evidenceRowsCsv, evidenceRowsMarkdown, evidenceText, extractEvidenceRows, type ClaimEvidenceRow } from "../skills/analysis/evidence-extract.js";
import { strictScoreMarkdown, type StrictScoreInput, type StrictScoreResult } from "../skills/analysis/ccf-a-score.js";
import { experimentPlanMarkdown, feasibilityMarkdown, revisedIdeaMarkdown } from "../skills/analysis/idea-refine.js";
import { assessNovelty, noveltyMatrixMarkdown } from "../skills/analysis/novelty-matrix.js";
import { relatedWorkMatrixCsv, topicClustersMarkdown } from "../skills/analysis/related-work-matrix.js";
import type { LiteratureSource, PaperCandidate } from "../skills/literature/types.js";
import { enrichCandidates } from "../skills/literature/venue.js";
import type { PdfChunkIndexEntry } from "../skills/pdf/chunk.js";
import type { PdfManifestRecord } from "../skills/pdf/provenance.js";
import { pdfChunksEqual, validateDownloadedPdfManifest } from "../skills/pdf/trust.js";
import { anonymityMarkdown, complianceMarkdown } from "../skills/templates/compliance.js";
import { createZipArchive, type ZipEntry } from "../skills/templates/package.js";
import { templateDecisionMarkdown } from "../skills/templates/resolve.js";
import type { PaperRenderInput, PaperRenderResult, TemplateComplianceResult, TemplateResolveInput, TemplateResolveResult } from "../skills/templates/types.js";
import { ApprovalRecorder, approvalPolicyForMode, type ApprovalPolicy, type ApprovalRecord } from "../runtime/approvals.js";
import { DecisionRecorder } from "../runtime/decisions.js";
import { runtimeTimestamp, type EventSink, type Idea2RepoEvent } from "../runtime/events.js";
import { appendScoreSnapshot, ensureRuntimeLedgers, evidenceItemsFromRows, replaceEvidenceItems, scoreSnapshotFromStrictScore } from "../runtime/ledgers.js";
import {
  activeClarificationQuestions,
  clarificationQuestionsMarkdown,
  ensureClarificationQuestionsLedger,
  generateClarificationQuestions,
  recordClarificationQuestions,
  type ClarificationQuestion
} from "../runtime/dialogue.js";
import { createCoreToolRegistry, createToolContext, type ToolContext, type ToolRegistry } from "../runtime/tools.js";
import { CODEX_CLI_PROVIDER_ID, OFFLINE_PROVIDER_ID, apiShapeForProvider, canonicalProvider } from "../providers.js";
import { createProviderAdapter } from "../providers/index.js";
import type { ProviderAdapter } from "../providers/adapter.js";
import { createResearchPipelineState, markStage, readResearchPipelineState, updateStageRefs, writeResearchPipelineState, type ResearchPipelineState } from "./stage-state.js";
import { researchStages, stageDefinition, type ResearchStageId } from "./stages.js";

export type StagedResearchAgent = Pick<
  CodexOAuthClient,
  "intakeIdea" | "planLiteratureSearch" | "triagePaperCandidates" | "readPaperPdf" | "analyzeRelatedWork" | "analyzeNovelty" | "scoreCcfA" | "reviewFeasibility" | "refineIdea"
>;

type PipelineTemplatePackage = {
  files: Record<string, string>;
};

export type ResearchPipelineOptions = {
  allowNetwork?: boolean;
  downloadPdfs?: boolean;
  maxPapers?: number;
  requestedDomains?: string[];
  timelineWeeks?: number;
  resources?: string[];
  stack?: "python" | "ts";
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  sources?: string[];
  outputRoot?: string;
  venue?: string;
  strictCcfA?: boolean;
  agentClient?: StagedResearchAgent;
  events?: EventSink;
  runId?: string;
  signal?: AbortSignal;
  progress?: (message: string) => void;
  stageOverrides?: ResearchPipelineStageOverrides;
  approvalPolicy?: ApprovalPolicy;
  approvalMode?: "deny" | "block";
};

export type ResearchPipelineStageOverrides = {
  fromStage?: ResearchStageId;
  retryFromStage?: ResearchStageId;
  skipStages?: Partial<Record<ResearchStageId, string>>;
};

export type ResearchPipelineResult = {
  state: ResearchPipelineState;
  ideaBrief: IdeaBrief;
  searchPlan: SearchPlan;
  verifiedPapers: PaperRecord[];
  baselineRecommendations: string[];
  datasetRecommendations: string[];
  metricRecommendations: string[];
  claimEvidenceRows: PipelineClaimEvidenceRow[];
  artifacts: Record<string, string>;
  warnings: string[];
  decisionSummaries: string[];
};

type PlannedClaimEvidenceRow = {
  claim: string;
  claim_type: "method";
  confidence: number;
  required_evidence: string;
  planned_artifact: string;
  status: "planned";
};

type PipelineClaimEvidenceRow = ClaimEvidenceRow | PlannedClaimEvidenceRow;

export async function runResearchPipeline(idea: string, options: ResearchPipelineOptions = {}): Promise<ResearchPipelineResult> {
  if (!idea.trim()) throw new Error("idea must not be empty");
  const outputRoot = options.outputRoot ?? process.cwd();
  const runId = options.runId ?? randomUUID();
  const emitRuntimeEvent = async (event: Idea2RepoEvent): Promise<void> => {
    await options.events?.emit(event);
  };
  if (options.signal?.aborted) {
    await emitRuntimeEvent({ type: "run.cancelled", run_id: runId, reason: abortReason(options.signal), timestamp: runtimeTimestamp() });
    throwIfAborted(options.signal);
  }
  const toolRegistry = createCoreToolRegistry();
  const approvalPolicy = options.approvalPolicy ?? approvalPolicyForMode("generate", { allowNetwork: Boolean(options.allowNetwork), allowOverwrite: true });
  if (options.outputRoot) {
    await ensureRuntimeLedgers(outputRoot);
    await ensureClarificationQuestionsLedger(outputRoot);
  }
  const restoredState = options.outputRoot ? await readResearchPipelineState(outputRoot) : null;
  if (restoredState && restoredState.idea !== idea) throw new Error(`research pipeline state belongs to a different idea: ${restoredState.idea}`);
  let state = restoredState ?? createResearchPipelineState(idea, options.outputRoot);
  const forcedFromStage = options.stageOverrides?.fromStage ?? options.stageOverrides?.retryFromStage;
  const forcedFromIndex = forcedFromStage ? stageDefinition(forcedFromStage).index : null;
  const isForcedStage = (id: ResearchStageId): boolean => forcedFromIndex !== null && stageDefinition(id).index >= forcedFromIndex;
  const skippedByOverride = new Set<ResearchStageId>();
  const warnings: string[] = [];
  const decisionSummaries: string[] = [];
  const resumedArtifacts: Record<string, string> = {};
  const readArtifact = async (relativePath: string): Promise<string | null> => {
    if (!options.outputRoot) return null;
    if (Object.hasOwn(resumedArtifacts, relativePath)) return resumedArtifacts[relativePath]!;
    try {
      const raw = await readFile(join(outputRoot, relativePath));
      const content = relativePath.endsWith(".zip") ? raw.toString("latin1") : raw.toString("utf8");
      resumedArtifacts[relativePath] = content;
      return content;
    } catch {
      return null;
    }
  };
  const canResumeStage = async (id: Parameters<typeof markStage>[1], extraArtifacts: string[] = []): Promise<boolean> => {
    if (!options.outputRoot) return false;
    if (await applySkipOverride(id)) return true;
    if (isForcedStage(id)) return false;
    const snapshot = state.stages.find((stage) => stage.id === id);
    if (!snapshot || (snapshot.status !== "completed" && snapshot.status !== "skipped")) return false;
    const artifactPaths = stageArtifactPaths(id, extraArtifacts).filter(Boolean);
    for (const relativePath of artifactPaths) {
      if (!(await exists(join(outputRoot, relativePath)))) return false;
    }
    await Promise.all(artifactPaths.map((relativePath) => readArtifact(relativePath)));
    options.progress?.(`Research pipeline: ${id} resumed from artifacts`);
    return true;
  };
  const preservedOutputArtifacts: Record<string, string> = {};
  const trustedPaperNotePaths = new Set<string>();
  const preserveStageArtifacts = async (id: Parameters<typeof markStage>[1], extraArtifacts: string[] = []): Promise<void> => {
    Object.assign(preservedOutputArtifacts, await readArtifacts(readArtifact, stageArtifactPaths(id, extraArtifacts)));
  };
  let activeStage: { id: Parameters<typeof markStage>[1]; label: string } | null = null;
  const decisions = options.outputRoot ? new DecisionRecorder(outputRoot, runId, options.events) : null;
  const recordDecision = async (input: Parameters<DecisionRecorder["record"]>[0]): Promise<void> => {
    decisionSummaries.push(`${input.title}: ${input.rationale_summary}`);
    const record = await decisions?.record(input);
    if (isResearchStageId(input.stage_id) && record) {
      state = updateStageRefs(state, input.stage_id, {
        decision_ids: [record.id],
        evidence_refs: input.evidence_refs.map(decisionEvidenceRef),
        next_actions: input.alternatives.map((alternative) => alternative.option)
      });
      if (options.outputRoot) await writeResearchPipelineState(outputRoot, state);
    }
  };
  const setStage = async (id: Parameters<typeof markStage>[1], status: Parameters<typeof markStage>[2], error?: string): Promise<void> => {
    throwIfAborted(options.signal);
    const stage = researchStages.find((candidate) => candidate.id === id);
    const label = stage?.label ?? id;
    if (status === "running") {
      activeStage = { id, label };
      options.progress?.(`Research pipeline: ${label}`);
    }
    state = markStage(state, id, status, { ...(error ? { error } : {}), artifacts: stageArtifactPaths(id) });
    if (options.outputRoot) await writeResearchPipelineState(outputRoot, state);
    const timestamp = runtimeTimestamp();
    if (status === "running") await emitRuntimeEvent({ type: "stage.started", run_id: runId, stage_id: id, label, timestamp });
    else if (status === "completed") await emitRuntimeEvent({ type: "stage.completed", run_id: runId, stage_id: id, artifacts: stageArtifactPaths(id), timestamp });
    else if (status === "skipped") await emitRuntimeEvent({ type: "stage.skipped", run_id: runId, stage_id: id, reason: error ?? "stage skipped", timestamp });
    else if (status === "failed") await emitRuntimeEvent({ type: "stage.failed", run_id: runId, stage_id: id, error: error ?? "stage failed", timestamp });
    if (status === "completed" || status === "skipped" || status === "failed") activeStage = null;
  };
  const markActiveStageBlocked = async (record: ApprovalRecord): Promise<void> => {
    const stage = activeStage;
    if (!stage) return;
    state = markStage(state, stage.id, "blocked", {
      blocker: `Pending approval ${record.id} for ${record.action}: ${record.risk.join(", ")}`,
      artifacts: stageArtifactPaths(stage.id)
    });
    if (options.outputRoot) await writeResearchPipelineState(outputRoot, state);
  };
  const restartActiveStageAfterApproval = async (record: ApprovalRecord): Promise<void> => {
    if (record.status !== "approved") return;
    const stage = activeStage;
    if (!stage) return;
    await setStage(stage.id, "running");
  };
  const toolContext = createToolContext({
    runId,
    outputRoot,
    events: options.events,
    permissions: approvalPolicy,
    approvals: options.outputRoot ? new ApprovalRecorder(outputRoot, approvalPolicy, options.events) : undefined,
    recordToolCalls: Boolean(options.outputRoot),
    approvalMode: options.approvalMode ?? "deny",
    stageId: () => activeStage?.id,
    onApprovalPending: markActiveStageBlocked,
    onApprovalResolved: restartActiveStageAfterApproval,
    signal: options.signal
  });
  const applySkipOverride = async (id: ResearchStageId): Promise<boolean> => {
    const reason = options.stageOverrides?.skipStages?.[id]?.trim();
    if (!reason) return false;
    if (!skippedByOverride.has(id)) {
      skippedByOverride.add(id);
      await setStage(id, "skipped", reason);
      await recordDecision({
        stage_id: id,
        title: `Skipped ${stageDefinition(id).label}`,
        rationale_summary: reason,
        inputs_considered: [id, "stage override"],
        evidence_refs: stageArtifactPaths(id).map((artifact) => ({ artifact })),
        alternatives: [{ option: "Run the stage", why_not: "A stage override explicitly skipped it." }],
        confidence: "medium"
      });
    }
    return true;
  };
  await emitRuntimeEvent({ type: "run.started", run_id: runId, idea, output_root: outputRoot, timestamp: runtimeTimestamp() });
  try {
  throwIfAborted(options.signal);
  const agent = createStagedAgent(options);
  const diagnosis = diagnoseIdea(idea, { requestedDomains: options.requestedDomains });
  const route = diagnosis.routes[0]!;
  const terms = seedTerms(idea);
  const venues = options.venue ? [options.venue] : route.domain.primary_venues.slice(0, 4);
  const deterministicIdeaBrief: IdeaBrief = {
    idea_summary: compactSentence(idea),
    problem: diagnosis.parsed_idea.problem,
    target_domain: route.domain.label,
    target_venues: venues,
    method_keywords: terms.filter((term) => /agent|model|system|algorithm|benchmark|runtime|security/i.test(term)).slice(0, 10),
    task_keywords: terms.slice(0, 10),
    evaluation_keywords: ["baseline", "dataset", "metric", "ablation", "failure case"],
    resource_constraints: options.resources?.length ? options.resources : ["single researcher", `${options.timelineWeeks ?? 12} weeks`],
    missing_information: [],
    assumptions: ["Offline pipeline artifacts are planning outputs until verified literature and PDF evidence are attached."],
    search_seed_terms: terms
  };
  let ideaBrief = deterministicIdeaBrief;
  if (await canResumeStage("idea_intake")) {
    ideaBrief = parseIdeaBriefArtifact((await readArtifact("docs/idea/idea_brief.md")) ?? "") ?? deterministicIdeaBrief;
  } else {
    await setStage("idea_intake", "running");
    ideaBrief = await stagedOrFallback(
      () => agent?.intakeIdea(idea, { requestedDomains: options.requestedDomains, targetVenues: venues, timelineWeeks: options.timelineWeeks, resources: options.resources }, options.progress).then((result) => result.idea_brief),
      () => deterministicIdeaBrief,
      warnings,
      "idea intake",
      options.signal
    );
    await recordDecision({
      stage_id: "idea_intake",
      title: "Idea routed for research pipeline",
      rationale_summary: `Routed the idea to ${ideaBrief.target_domain} with venues ${ideaBrief.target_venues.join(", ") || "auto-selected"}.`,
      inputs_considered: [idea, ...(options.requestedDomains ?? []), ...(options.resources ?? [])],
      evidence_refs: [{ artifact: "docs/idea/idea_brief.md" }],
      alternatives: [{ option: "Defer routing", why_not: "The parsed idea had enough terms to create a deterministic research brief." }],
      confidence: "medium"
    });
    await setStage("idea_intake", "completed");
  }

  let searchPlan: SearchPlan;
  const resumedSearchPlan = await readJsonArtifact<SearchPlan>(readArtifact, "docs/relative_work/search_plan.json");
  if ((await canResumeStage("search_planning")) && resumedSearchPlan) {
    searchPlan = resumedSearchPlan;
  } else {
    await setStage("search_planning", "running");
    searchPlan = await stagedOrFallback(
      () => agent?.planLiteratureSearch(idea, { requestedDomains: options.requestedDomains, targetVenues: venues, timelineWeeks: options.timelineWeeks, resources: options.resources }, options.progress).then((result) => result.search_plan),
      () => offlineSearchPlan(ideaBrief, options.maxPapers ?? 20),
      warnings,
      "search planning",
      options.signal
    );
    searchPlan = enforceSearchPlanGate(searchPlan, offlineSearchPlan(ideaBrief, options.maxPapers ?? 20), warnings);
    await recordDecision({
      stage_id: "search_planning",
      title: "Literature search plan selected",
      rationale_summary: `Selected ${searchPlan.precision_queries.length} precision and ${searchPlan.recall_queries.length} recall queries with baseline, dataset, venue, and collision coverage.`,
      inputs_considered: [ideaBrief.idea_summary, ideaBrief.target_domain, ...ideaBrief.search_seed_terms],
      evidence_refs: [{ artifact: "docs/relative_work/search_plan.json" }],
      alternatives: [{ option: "Use a single broad query", why_not: "The evidence-first pipeline needs separate precision, recall, baseline, dataset, venue, and collision searches." }],
      confidence: "medium"
    });
    await setStage("search_planning", "completed");
  }
  searchPlan = enforceSearchPlanGate(searchPlan, offlineSearchPlan(ideaBrief, options.maxPapers ?? 20), warnings);

  let candidates: PaperCandidate[];
  let searchReport: string;
  const resumedCandidates = await readJsonArtifact<PaperCandidate[]>(readArtifact, "docs/relative_work/candidates.json");
  if ((await canResumeStage("literature_search")) && resumedCandidates) {
    candidates = enrichCandidates(resumedCandidates, { idea, targetVenues: venues });
    searchReport = (await readArtifact("docs/relative_work/search_report.md")) ?? "# Literature Search Report\n\nResumed from candidate artifacts.\n";
  } else {
    await setStage("literature_search", "running");
    const queries = searchPlanQueries(searchPlan);
    const literature = await toolRegistry.execute<LiteratureSearchOptions, LiteratureSearchResult>("literature.search", {
      queries,
      allowNetwork: Boolean(options.allowNetwork),
      limit: options.maxPapers ?? 20,
      idea,
      targetVenues: venues,
      sources: options.sources as LiteratureSource[] | undefined
    }, toolContext);
    warnings.push(...literature.warnings);
    candidates = enrichCandidates(literature.candidates, { idea, targetVenues: venues });
    searchReport = literature.search_report;
    for (const candidate of candidates) {
      await emitRuntimeEvent({
        type: "paper.found",
        run_id: runId,
        stage_id: "literature_search",
        paper_id: safePaperId(candidate.candidate_id || candidate.title),
        title: candidate.title,
        venue: candidate.venue,
        year: candidate.year,
        relevance_score: candidate.relevance_score,
        ccf_rank: candidate.ccf_rank,
        venue_match: candidate.venue_match,
        track_status: candidate.track_status,
        novelty_risk: candidate.novelty_risk ?? "unknown",
        pdf_status: candidate.pdf_status ?? (candidate.pdf_urls.length ? "available" : "unavailable"),
        reason: candidate.reason,
        timestamp: runtimeTimestamp()
      });
    }
    await setStage("literature_search", "completed");
  }

  let agentTriage: CandidateTriage | null = null;
  const candidateTriageGatePassed = candidates.length >= 8;
  if (candidates.length > 0 && !candidateTriageGatePassed) warnings.push(`Candidate triage gate blocked: ${candidates.length} candidates found; at least 8 core papers are required before triage.`);
  if ((await canResumeStage("candidate_triage")) && candidateTriageGatePassed) {
    await preserveStageArtifacts("candidate_triage");
  } else {
    await setStage("candidate_triage", "running");
    agentTriage = candidateTriageGatePassed
      ? await stagedOrFallback(
          () => agent?.triagePaperCandidates(idea, candidates, options.progress).then((result) => result.triage),
          () => null,
          warnings,
          "candidate triage",
          options.signal
        )
      : null;
    await recordDecision({
      stage_id: "candidate_triage",
      title: "Candidate triage scope selected",
      rationale_summary: agentTriage
        ? `Marked ${agentTriage.must_read_core_papers.length} must-read papers, ${agentTriage.weakly_related.length} weakly-related papers, and ${agentTriage.duplicates.length} duplicates.`
        : `Candidate triage was skipped because ${candidates.length ? "fewer than 8 core candidates were available" : "no literature candidates were collected"}.`,
      inputs_considered: [`candidate_count=${candidates.length}`, `triage_gate=${candidateTriageGatePassed ? "passed" : "blocked"}`],
      evidence_refs: [{ artifact: "docs/relative_work/candidates.json" }, { artifact: "docs/relative_work/triage_report.md" }],
      alternatives: [{ option: "Treat all candidates as equally important", why_not: "Reviewer-facing related work needs explicit must-read, weakly-related, duplicate, and missing-area distinctions." }],
      confidence: candidateTriageGatePassed && agentTriage ? "medium" : "high"
    });
    await setStage("candidate_triage", candidateTriageGatePassed ? "completed" : "skipped", candidateTriageGatePassed ? undefined : candidates.length ? "At least 8 core papers are required before triage." : "No literature candidates were collected.");
  }

  let manifest: PdfManifestRecord[];
  const resumedManifest = await readJsonArtifact<PdfManifestRecord[]>(readArtifact, "docs/reference/pdf_manifest.json");
  if ((await canResumeStage("pdf_acquisition")) && resumedManifest && (await validateDownloadedPdfManifest(outputRoot, resumedManifest))) {
    manifest = resumedManifest;
    await preserveStageArtifacts("pdf_acquisition");
  } else {
    if (resumedManifest && !(await validateDownloadedPdfManifest(outputRoot, resumedManifest))) {
      warnings.push("PDF acquisition resume ignored because one or more downloaded PDF records failed provenance validation.");
    }
    await setStage("pdf_acquisition", "running");
    manifest = await toolRegistry.execute<{ candidates: PaperCandidate[]; outputRoot: string; allowNetwork: boolean; downloadPdfs: boolean }, PdfManifestRecord[]>("pdf.acquire", {
      candidates,
      outputRoot,
      allowNetwork: Boolean(options.allowNetwork),
      downloadPdfs: Boolean(options.downloadPdfs)
    }, toolContext);
    for (const record of manifest.filter((candidate) => candidate.status === "downloaded" && candidate.pdf_path && candidate.pdf_sha256 && candidate.bytes)) {
      await emitRuntimeEvent({
        type: "pdf.downloaded",
        run_id: runId,
        paper_id: record.paper_id,
        path: record.pdf_path!,
        sha256: record.pdf_sha256!,
        bytes: record.bytes!,
        source_url: record.source_url,
        extraction_quality: record.extraction_quality?.quality,
        mean_chars_per_page: record.extraction_quality?.mean_chars_per_page,
        weak_pages: record.extraction_quality?.weak_pages,
        extraction_pages: record.extraction_quality?.pages,
        timestamp: record.downloaded_at ?? runtimeTimestamp()
      });
    }
    await setStage("pdf_acquisition", candidates.length ? "completed" : "skipped", candidates.length ? undefined : "No candidates available for PDF acquisition.");
  }

  let chunks: PdfChunkIndexEntry[];
  let agentPaperNotes: PdfPaperNote[] = [];
  const resumedChunks = await readJsonArtifact<PdfChunkIndexEntry[]>(readArtifact, "docs/reference/pdf_chunks.json");
  const parsedManifestChunks = await toolRegistry.execute<{ root: string; manifest: PdfManifestRecord[] }, PdfChunkIndexEntry[]>("pdf.chunk", { root: outputRoot, manifest }, toolContext);
  const trustedResumedChunks = resumedChunks && pdfChunksEqual(resumedChunks, parsedManifestChunks) ? parsedManifestChunks : null;
  const canResumePdfReading = Boolean(
    trustedResumedChunks?.length &&
      resumedChunks &&
      trustedResumedChunks.length === resumedChunks.length &&
      (await canResumeStage("pdf_reading", ["docs/reference/pdf_chunks.json"]))
  );
  if (canResumePdfReading && trustedResumedChunks) {
    chunks = trustedResumedChunks;
    agentPaperNotes = await paperNotesFromArtifacts(readArtifact, chunks, trustedPaperNotePaths);
    await preserveStageArtifacts("pdf_reading", ["docs/reference/pdf_chunks.json"]);
  } else {
    if (resumedChunks?.length) warnings.push("PDF reading resume ignored because chunks are not fully backed by validated PDF provenance and declared artifacts.");
    await setStage("pdf_reading", "running");
    chunks = parsedManifestChunks;
    agentPaperNotes = verifiedPaperNotesAgainstChunks(await readPaperNotesWithAgent(agent, idea, chunks, warnings, options.progress, options.signal), chunks);
    await setStage("pdf_reading", chunks.length ? "completed" : "skipped", chunks.length ? undefined : "No downloaded PDFs were available for reading.");
  }

  const evidenceRows = await toolRegistry.execute<{ chunks: PdfChunkIndexEntry[] }, ReturnType<typeof extractEvidenceRows>>("evidence.extract", { chunks }, toolContext);
  const verifiedEvidenceRows = evidenceRows.filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id);
  const evidenceItems = evidenceItemsFromRows({
    runId,
    stageId: "pdf_reading",
    rows: evidenceRows,
    candidates,
    manifest,
    chunks
  });
  if (options.outputRoot) await replaceEvidenceItems(outputRoot, { runId, stageId: "pdf_reading" }, evidenceItems);
  if (evidenceItems.length) {
    state = updateStageRefs(state, "pdf_reading", { evidence_refs: evidenceItems.map((item) => item.id) });
    if (options.outputRoot) await writeResearchPipelineState(outputRoot, state);
  }
  for (const item of evidenceItems) {
    await emitRuntimeEvent({
      type: "evidence.extracted",
      run_id: runId,
      evidence_id: item.id,
      paper_id: item.paper_id,
      title: item.title,
      venue: item.venue,
      claim: item.paraphrase,
      claim_type: item.claim_type,
      page: item.page,
      section: item.section,
      quote: item.quote,
      chunk_id: item.chunk_id,
      confidence: item.confidence,
      provenance: item.provenance,
      timestamp: runtimeTimestamp()
    });
  }
  const hasVerifiedPdfEvidence = evidenceItems.length > 0;
  const noteArtifacts = { ...evidenceRowsMarkdown(evidenceRows, chunks), ...paperNoteArtifacts(agentPaperNotes, chunks) };
  if (!canResumePdfReading) {
    await recordDecision({
      stage_id: "pdf_reading",
      title: "PDF evidence availability summarized",
      rationale_summary: chunks.length
        ? `Read ${chunks.length} PDF chunks and found ${verifiedEvidenceRows.length} verified evidence rows with page, quote, and chunk id.`
        : "PDF reading was skipped because no downloaded PDFs were available; downstream evidence remains planned rather than verified.",
      inputs_considered: [`pdf_chunks=${chunks.length}`, `verified_evidence_rows=${verifiedEvidenceRows.length}`, `paper_notes=${agentPaperNotes.length}`],
      evidence_refs: [{ artifact: "docs/reference/pdf_chunks.json" }, { artifact: "docs/reference/claim_evidence_matrix.csv" }],
      alternatives: [{ option: "Infer evidence from metadata only", why_not: "The evidence gate requires page, quote, and chunk ids before claims can be treated as verified." }],
      confidence: hasVerifiedPdfEvidence ? "medium" : "high"
    });
  }
  let agentRelatedWork: RelatedWorkAnalysis | null = null;
  const canResumeAgentAnalyses = hasVerifiedPdfEvidence && agentPaperNotes.length > 0;
  const relatedWorkResumed = (await canResumeStage("related_work_analysis")) && canResumeAgentAnalyses;
  let relatedWorkAvailable = false;
  if (relatedWorkResumed) {
    await preserveStageArtifacts("related_work_analysis");
    relatedWorkAvailable = true;
  } else {
    await setStage("related_work_analysis", "running");
    agentRelatedWork =
      canResumeAgentAnalyses
        ? await stagedOrFallback(
            () => agent?.analyzeRelatedWork(idea, agentPaperNotes, options.progress).then((result) => result.related_work),
            () => null,
            warnings,
            "related work analysis",
            options.signal
          )
        : null;
    await setStage("related_work_analysis", agentRelatedWork ? "completed" : "skipped", agentRelatedWork ? undefined : "No verified paper notes are available for related-work agent analysis.");
    await recordDecision({
      stage_id: "related_work_analysis",
      title: "Related work synthesis scope selected",
      rationale_summary: agentRelatedWork
        ? `Synthesized ${agentRelatedWork.topic_clusters.length} topic clusters and ${agentRelatedWork.reviewer_expected_baselines.length} reviewer-expected baselines from verified paper notes.`
        : "Related-work agent analysis was skipped because verified paper notes were unavailable.",
      inputs_considered: [`verified_pdf_evidence=${hasVerifiedPdfEvidence}`, `paper_notes=${agentPaperNotes.length}`],
      evidence_refs: [{ artifact: "docs/relative_work/related_work_matrix.csv" }, { artifact: "docs/relative_work/topic_clusters.md" }],
      alternatives: [{ option: "Write a narrative survey without verified notes", why_not: "The runtime contract requires evidence-gated related-work synthesis." }],
      confidence: agentRelatedWork ? "medium" : "high"
    });
    relatedWorkAvailable = Boolean(agentRelatedWork);
  }

  const novelty = assessNovelty(idea, candidates, evidenceRows, chunks);
  let agentNovelty: NoveltyGapAnalysis | null = null;
  const noveltyResumed = (await canResumeStage("novelty_analysis")) && relatedWorkAvailable;
  let noveltyAvailable = false;
  if (noveltyResumed) {
    await preserveStageArtifacts("novelty_analysis");
    noveltyAvailable = true;
  } else {
    await setStage("novelty_analysis", "running");
    agentNovelty =
      hasVerifiedPdfEvidence && agentRelatedWork
        ? await stagedOrFallback(
            () => agent?.analyzeNovelty(idea, agentRelatedWork, options.progress).then((result) => result.novelty),
            () => null,
            warnings,
            "novelty analysis",
            options.signal
          )
        : null;
    await setStage("novelty_analysis", agentNovelty ? "completed" : "skipped", agentNovelty ? undefined : "Verified related-work analysis is required before novelty agent analysis.");
    await recordDecision({
      stage_id: "novelty_analysis",
      title: "Novelty collision risk assessed",
      rationale_summary: agentNovelty
        ? `Agent novelty review assessed collision risk as ${agentNovelty.collision_risk} with ${agentNovelty.novelty_gaps.length} defensible gaps.`
        : `Deterministic novelty assessment marked collision risk as ${novelty.collision_risk}: ${novelty.reasons.join("; ") || "no detailed collision reasons"}.`,
      inputs_considered: [`collision_risk=${agentNovelty?.collision_risk ?? novelty.collision_risk}`, `related_work_available=${relatedWorkAvailable}`],
      evidence_refs: [{ artifact: "docs/relative_work/novelty_gap_matrix.md" }, { artifact: "docs/relative_work/collision_risk.md" }],
      alternatives: [{ option: "Assume novelty from the initial idea", why_not: "Novelty must be checked against related work and evidence rows before paper claims are upgraded." }],
      confidence: agentNovelty ? "medium" : "high"
    });
    noveltyAvailable = Boolean(agentNovelty);
  }

  const verifiedPaperCount = verifiedEvidencePaperCount(evidenceRows);
  const evidence = evidenceText(evidenceRows);
  const scoreInput: StrictScoreInput = {
    verifiedRelatedWorkCount: verifiedPaperCount,
    pdfReadCount: new Set(chunks.map((chunk) => chunk.paper_id)).size,
    corePaperCount: verifiedPaperCount,
    evidenceRefs: evidenceItems.map((item) => item.id),
    hasStrongBaseline: evidence.includes("baseline"),
    hasDatasetOrBenchmark: evidence.includes("dataset") || evidence.includes("benchmark"),
    hasMetric: evidence.includes("metric") || evidence.includes("accuracy") || evidence.includes("latency"),
    highPriorWorkCollision: novelty.collision_risk === "high",
    hasScientificHypothesis: /\bhypothesis\b|\bclaim\b/.test(evidence),
    hasExecutableExperimentPlan: evidence.includes("experiment") && evidence.includes("baseline") && evidence.includes("metric"),
    singlePersonTwelveWeekInfeasible: (options.resources ?? []).some((resource) => /single|solo|one/i.test(resource)) && (options.timelineWeeks ?? 12) <= 12,
    venueRequiresThreatModel: /ccs|security|s&p|ndss/i.test(options.venue ?? ""),
    hasThreatModel: evidence.includes("threat model"),
    venueRequiresSystemEvaluation: /osdi|sosp|sigcomm|atc|systems/i.test(options.venue ?? ""),
    hasPrototype: evidence.includes("prototype"),
    venueExpectsStrongMlBaselines: /neurips|icml|iclr|acl/i.test(options.venue ?? ""),
    hasStrongMlBaselines: evidence.includes("baseline")
  };
  const score = await toolRegistry.execute<StrictScoreInput, StrictScoreResult>("ccf_a.score", scoreInput, toolContext);
  if (options.outputRoot) {
    await appendScoreSnapshot(outputRoot, scoreSnapshotFromStrictScore({
      runId,
      stageId: "ccf_a_strict_scoring",
      score,
      evidenceRefs: evidenceItems.map((item) => item.id)
    }));
  }
  await emitRuntimeEvent({
    type: "score.updated",
    run_id: runId,
    stage_id: "ccf_a_strict_scoring",
    score: score.total,
    max_score: 100,
    confidence: score.confidence,
    hard_blockers: score.caps.map((cap) => cap.reason),
    timestamp: runtimeTimestamp()
  });
  let agentScore: StrictCcfAReview | null = null;
  const strictScoreResumed = canResumePdfReading && hasVerifiedPdfEvidence && (await canResumeStage("ccf_a_strict_scoring"));
  if (!strictScoreResumed) {
    await setStage("ccf_a_strict_scoring", "running");
    agentScore = hasVerifiedPdfEvidence
      ? await stagedOrFallback(
          () => agent?.scoreCcfA(idea, { evidence_rows: evidenceRows, strict_score: score, novelty }, options.progress).then((result) => result.scorecard),
          () => null,
          warnings,
          "strict CCF-A scoring",
          options.signal
        )
      : null;
    await recordDecision({
      stage_id: "ccf_a_strict_scoring",
      title: "Strict CCF-A score capped by evidence",
      rationale_summary: `Strict score is ${score.total}/100 with caps: ${score.caps.map((cap) => cap.reason).join("; ") || "none"}.`,
      inputs_considered: [`verified_papers=${verifiedPaperCount}`, `pdf_chunks=${chunks.length}`, `collision=${novelty.collision_risk}`],
      evidence_refs: [{ artifact: "docs/diagnosis/ccf_a_strict_scorecard.md" }, { artifact: "docs/reference/claim_evidence_matrix.csv" }],
      alternatives: [{ option: "Score from ambition only", why_not: "The strict rubric caps claims without verified related-work and PDF evidence." }],
      confidence: hasVerifiedPdfEvidence ? "medium" : "high"
    });
    await setStage("ccf_a_strict_scoring", "completed");
  } else {
    await preserveStageArtifacts("ccf_a_strict_scoring");
  }

  let clarificationQuestions: ClarificationQuestion[] = [];
  if (await canResumeStage("clarification_dialogue")) {
    clarificationQuestions = options.outputRoot ? await activeClarificationQuestions(outputRoot, runId).catch(() => []) : [];
    await preserveStageArtifacts("clarification_dialogue");
  } else {
    await setStage("clarification_dialogue", "running");
    const existingQuestions = options.outputRoot ? await activeClarificationQuestions(outputRoot, runId).catch(() => []) : [];
    const generatedQuestions = generateClarificationQuestions({
      runId,
      idea,
      score,
      scoreInput,
      novelty,
      evidenceRefs: evidenceItems.map((item) => item.id),
      existing: existingQuestions
    });
    if (options.outputRoot) await recordClarificationQuestions(outputRoot, generatedQuestions, { runId });
    clarificationQuestions = options.outputRoot
      ? await activeClarificationQuestions(outputRoot, runId).catch(() => [...existingQuestions, ...generatedQuestions])
      : [...existingQuestions, ...generatedQuestions];
    for (const question of generatedQuestions) {
      await emitRuntimeEvent({
        type: "question.asked",
        run_id: runId,
        question_id: question.id,
        question: question.question,
        why_it_matters: question.whyItMatters,
        related_score_dimensions: question.relatedScoreDimensions,
        evidence_refs: question.evidenceRefs,
        options: question.options,
        required: question.required,
        timestamp: question.created_at
      });
    }
    await recordDecision({
      stage_id: "clarification_dialogue",
      title: "Clarification questions selected",
      rationale_summary: generatedQuestions.length
        ? `Generated ${generatedQuestions.length} uncertainty-driven clarification question(s) from score caps and novelty gaps.`
        : "No clarification question was generated because the current score and novelty state did not expose a new active uncertainty.",
      inputs_considered: [
        `score=${score.total}`,
        `caps=${score.caps.map((cap) => cap.reason).join("; ") || "none"}`,
        `novelty_collision=${novelty.collision_risk}`
      ],
      evidence_refs: [{ artifact: "docs/diagnosis/clarification_questions.md" }],
      alternatives: [{ option: "Ask an open-ended follow-up", why_not: "Questions are constrained to score dimensions so answers can deterministically refresh readiness." }],
      confidence: generatedQuestions.length ? "high" : "medium"
    });
    await setStage("clarification_dialogue", generatedQuestions.length ? "completed" : "skipped", generatedQuestions.length ? undefined : "No active clarification question required.");
  }

  let agentFeasibility: FeasibilityReview | null = null;
  if (!(await canResumeStage("feasibility_review"))) {
    await setStage("feasibility_review", "running");
    agentFeasibility = await stagedOrFallback(
      () => agent?.reviewFeasibility(idea, { timelineWeeks: options.timelineWeeks ?? 12, resources: options.resources ?? [] }, options.progress).then((result) => result.feasibility),
      () => null,
      warnings,
      "feasibility review",
      options.signal
    );
    await recordDecision({
      stage_id: "feasibility_review",
      title: "Feasibility constraints reviewed",
      rationale_summary: `Reviewed feasibility for ${options.timelineWeeks ?? 12} weeks with resources: ${(options.resources ?? []).join(", ") || "unspecified"}.`,
      inputs_considered: [`timeline_weeks=${options.timelineWeeks ?? 12}`, ...(options.resources ?? [])],
      evidence_refs: [{ artifact: "docs/diagnosis/feasibility_report.md" }],
      alternatives: [{ option: "Assume unlimited resources", why_not: "The roadmap requires single-researcher and resource constraints to be modeled explicitly." }],
      confidence: "medium"
    });
    await setStage("feasibility_review", "completed");
  } else {
    await preserveStageArtifacts("feasibility_review");
  }

  const verifiedEvidence = evidenceText(evidenceRows.filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id));
  const baselineRecommendations = verifiedEvidence.includes("baseline") ? ["Verified PDF evidence mentions baseline comparison; inspect paper notes before selecting the final baseline."] : [];
  const datasetRecommendations = verifiedEvidence.includes("dataset") || verifiedEvidence.includes("benchmark") ? ["Verified PDF evidence mentions dataset or benchmark usage; inspect paper notes before selecting data."] : [];
  const metricRecommendations = verifiedEvidence.includes("metric") || verifiedEvidence.includes("accuracy") || verifiedEvidence.includes("latency") ? ["Verified PDF evidence mentions metrics; inspect paper notes before selecting primary and secondary metrics."] : [];
  const claimEvidenceRows = evidenceRows.length ? evidenceRows : [
    {
      claim: "Main contribution improves over verified baselines.",
      claim_type: "method" as const,
      confidence: 0,
      required_evidence: "At least one result table linked to verified baseline, dataset, and metric.",
      planned_artifact: "results/tables/main_results.csv",
      status: "planned" as const
    }
  ];

  let agentStrategy: ResearchStrategy | null = null;
  const strategyResumed = (await canResumeStage("better_idea_synthesis")) && relatedWorkAvailable && noveltyAvailable;
  if (strategyResumed) {
    await preserveStageArtifacts("better_idea_synthesis");
  } else {
    await setStage("better_idea_synthesis", "running");
    agentStrategy = hasVerifiedPdfEvidence && agentRelatedWork && (agentNovelty ?? novelty)
      ? await stagedOrFallback(
          () => agent?.refineIdea(idea, { novelty: agentNovelty ?? novelty, score, feasibility: agentFeasibility, related_work: agentRelatedWork }, options.progress).then((result) => result.strategy),
          () => null,
          warnings,
          "research strategy",
          options.signal
        )
      : null;
    await setStage("better_idea_synthesis", agentStrategy ? "completed" : "skipped", agentStrategy ? undefined : "Research strategy is blocked until verified related work and novelty analysis exist.");
    await recordDecision({
      stage_id: "better_idea_synthesis",
      title: "Research strategy revision selected",
      rationale_summary: agentStrategy
        ? `Revised the idea around hypothesis "${agentStrategy.central_hypothesis}" with ${agentStrategy.baselines.length} baselines, ${agentStrategy.datasets.length} datasets, and ${agentStrategy.metrics.length} metrics.`
        : "Better-idea synthesis was blocked until verified related work, novelty analysis, and PDF-backed evidence are available.",
      inputs_considered: [`verified_pdf_evidence=${hasVerifiedPdfEvidence}`, `related_work_available=${relatedWorkAvailable}`, `novelty_available=${noveltyAvailable}`],
      evidence_refs: [{ artifact: "docs/proposal/revised_idea.md" }, { artifact: "docs/proposal/experiment_plan.md" }],
      alternatives: [{ option: "Keep the initial idea unchanged", why_not: "The runtime plan requires evidence-driven idea revision when enough related-work and novelty context exists." }],
      confidence: agentStrategy ? "medium" : "high"
    });
  }

  let templatePackage: PipelineTemplatePackage;
  const templateArtifactPaths = stageArtifactPaths("venue_template_packaging", ["paper/submission/submission.zip"]);
  if (await canResumeStage("venue_template_packaging", ["paper/submission/submission.zip"])) {
    templatePackage = { files: await readArtifacts(readArtifact, templateArtifactPaths) };
    await preserveStageArtifacts("venue_template_packaging", ["paper/submission/submission.zip"]);
  } else {
    await setStage("venue_template_packaging", "running");
    templatePackage = await templatePackageArtifacts({
      idea,
      projectName: "evidence-first-research-draft",
      venue: options.venue ?? venues[0],
      domain: route.domain.key,
      strict: Boolean(options.strictCcfA)
    }, toolRegistry, toolContext);
    await recordDecision({
      stage_id: "venue_template_packaging",
      title: "Venue template package selected",
      rationale_summary: `Selected a venue-aware template package for ${options.venue ?? route.domain.primary_venues[0] ?? "the routed domain"}.`,
      inputs_considered: [options.venue ?? "auto venue", route.domain.key, Boolean(options.strictCcfA) ? "strict" : "standard"],
      evidence_refs: [{ artifact: "docs/submission/template_decision.md" }, { artifact: "docs/submission/venue_template_profile.json" }],
      alternatives: [{ option: "Use generic article only", why_not: "Venue fit and submission readiness require a venue-specific profile when available." }],
      confidence: "medium"
    });
    await setStage("venue_template_packaging", "completed");
  }

  const artifacts = {
    ...pipelineArtifacts({
    idea,
    ideaBrief,
    searchPlan,
    candidates,
    manifest,
    chunks,
    evidenceRows,
    noteArtifacts,
    novelty,
    score,
    clarificationQuestions,
    searchReport,
    baselineRecommendations,
    datasetRecommendations,
    metricRecommendations,
    claimEvidenceRows,
    strict: Boolean(options.strictCcfA),
    agentTriage,
    agentRelatedWork,
    agentNovelty,
    agentScore,
    agentFeasibility,
    agentStrategy,
    templatePackage
    }),
    ...preservableOutputArtifacts(preservedOutputArtifacts),
    ...preservedPaperNoteArtifacts(resumedArtifacts, trustedPaperNotePaths)
  };
  if (!(await canResumeStage("artifact_writing"))) {
    await setStage("artifact_writing", "running");
    await setStage("artifact_writing", "completed");
  }
  const result = {
    state,
    ideaBrief,
    searchPlan,
    verifiedPapers: verifiedPaperRecords(candidates, manifest, evidenceRows),
    baselineRecommendations,
    datasetRecommendations,
    metricRecommendations,
    claimEvidenceRows,
    artifacts,
    warnings: [...warnings, ...(options.allowNetwork ? [] : ["Network disabled; literature candidates require a later search stage."])],
    decisionSummaries
  };
  await emitRuntimeEvent({ type: "run.completed", run_id: runId, timestamp: runtimeTimestamp() });
  return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStage = activeStage as { id: Parameters<typeof markStage>[1]; label: string } | null;
    if (failedStage) {
      state = markStage(state, failedStage.id, "failed", { error: message, artifacts: stageArtifactPaths(failedStage.id) });
      if (options.outputRoot) await writeResearchPipelineState(outputRoot, state);
      await emitRuntimeEvent({ type: "stage.failed", run_id: runId, stage_id: failedStage.id, error: message, timestamp: runtimeTimestamp() });
    }
    if (options.signal?.aborted) await emitRuntimeEvent({ type: "run.cancelled", run_id: runId, reason: message, timestamp: runtimeTimestamp() });
    else await emitRuntimeEvent({ type: "run.failed", run_id: runId, error: message, timestamp: runtimeTimestamp() });
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(signal.reason ? String(signal.reason) : "run cancelled");
}

function abortReason(signal: AbortSignal | undefined): string {
  return signal?.reason ? String(signal.reason) : "run cancelled";
}

function offlineSearchPlan(brief: IdeaBrief, maxPapers: number): SearchPlan {
  const base = brief.search_seed_terms.slice(0, 5);
  const phrase = base.join(" ") || brief.idea_summary;
  const precisionQueries = [
    `${phrase} benchmark baseline`,
    `${phrase} ${brief.target_domain}`,
    `${phrase} evaluation metric`,
    `${phrase} recent 2026`,
    `${phrase} prior work`
  ];
  const recallQueries = [
    `${base[0] ?? phrase} survey`,
    `${base.slice(0, 2).join(" ")} related work`,
    `${phrase} arxiv`,
    `${phrase} dataset`,
    `${phrase} limitations`
  ];
  return {
    core_concepts: base,
    synonyms: [...new Set([...base, "evaluation", "baseline", "benchmark"])],
    precision_queries: precisionQueries.map((query) => ({ query, source_hints: ["openalex", "dblp", "semantic-scholar"], purpose: "find direct prior work" })),
    recall_queries: recallQueries.map((query) => ({ query, source_hints: ["openalex", "crossref", "arxiv"], purpose: "broaden related-work coverage" })),
    baseline_queries: [{ query: `${phrase} baseline comparison`, source_hints: ["semantic-scholar", "openalex"], purpose: "find reviewer-expected baselines" }],
    dataset_metric_queries: [{ query: `${phrase} dataset metric benchmark`, source_hints: ["semantic-scholar", "arxiv"], purpose: "find datasets and metrics" }],
    venue_queries: brief.target_venues.map((venue) => ({ query: `${venue} ${phrase}`, source_hints: ["dblp", "venue"], purpose: "find venue-specific work" })),
    collision_queries: [{ query: `"${phrase}" novelty gap`, source_hints: ["openalex", "semantic-scholar"], purpose: "find novelty collisions" }],
    stop_condition: `Stop when at least ${Math.min(maxPapers, 20)} relevant candidates include core prior work, baselines, datasets, and metrics.`
  };
}

function pipelineArtifacts(input: {
  idea: string;
  ideaBrief: IdeaBrief;
  searchPlan: SearchPlan;
  candidates: PaperCandidate[];
  manifest: PdfManifestRecord[];
  chunks: Array<{ paper_id: string; chunk_id: string; page: number; text: string }>;
  evidenceRows: ReturnType<typeof extractEvidenceRows>;
  noteArtifacts: Record<string, string>;
  novelty: ReturnType<typeof assessNovelty>;
  score: StrictScoreResult;
  clarificationQuestions: ClarificationQuestion[];
  searchReport: string;
  baselineRecommendations: string[];
  datasetRecommendations: string[];
  metricRecommendations: string[];
  claimEvidenceRows: PipelineClaimEvidenceRow[];
  strict: boolean;
  agentTriage: CandidateTriage | null;
  agentRelatedWork: RelatedWorkAnalysis | null;
  agentNovelty: NoveltyGapAnalysis | null;
  agentScore: StrictCcfAReview | null;
  agentFeasibility: FeasibilityReview | null;
  agentStrategy: ResearchStrategy | null;
  templatePackage: PipelineTemplatePackage;
}): Record<string, string> {
  const verifiedPapers = verifiedPaperRecords(input.candidates, input.manifest, input.evidenceRows);
  const verifiedPaperIds = new Set(verifiedPapers.map((paper) => paper.paper_id));
  const evidenceBackedCandidates = input.candidates.filter((candidate) => verifiedPaperIds.has(safePaperId(candidate.candidate_id)));
  const relatedWorkReport = input.agentRelatedWork && verifiedPapers.length ? agentRelatedWorkMarkdown(input.agentRelatedWork) : topicClustersMarkdown(evidenceBackedCandidates);
  const noveltyReport = input.agentNovelty ? `${noveltyMatrixMarkdown(input.novelty)}\n## Agent Novelty Review\n\n${agentNoveltyMarkdown(input.agentNovelty)}` : noveltyMatrixMarkdown(input.novelty);
  const feasibilityReport = input.agentFeasibility ? agentFeasibilityMarkdown(input.agentFeasibility) : feasibilityMarkdown(input.ideaBrief.resource_constraints, 12);
  const experimentPlan = `${experimentPlanMarkdown()}\n## Evidence Status\n\n- Baselines evidence-backed: ${input.baselineRecommendations.length ? "yes" : "no"}\n- Datasets evidence-backed: ${input.datasetRecommendations.length ? "yes" : "no"}\n- Metrics evidence-backed: ${input.metricRecommendations.length ? "yes" : "no"}\n`;
  const revisedIdea = input.agentStrategy ? agentStrategyRevisedIdeaMarkdown(input.agentStrategy) : revisedIdeaMarkdown(input.idea, input.novelty, input.score);
  const firstFourWeekPlan = input.agentStrategy ? agentFirstFourWeekPlanMarkdown(input.agentStrategy) : "# First 4 Week Plan\n\n1. Plan search and triage candidates.\n2. Acquire and read PDFs.\n3. Build evidence matrices.\n4. Lock experiments and paper story.\n";
  const paperStory = input.agentStrategy ? `# Paper Story\n\n${input.agentStrategy.paper_story}\n` : "# Paper Story\n\nPaper story is blocked until related work, novelty, and experiment evidence are verified.\n";
  const scorecard = `${strictScoreMarkdown(input.score)}${input.agentScore ? `\n## Agent Review\n\n${agentScoreMarkdown(input.agentScore)}` : ""}\nStrict mode: ${input.strict ? "enabled" : "disabled"}\n`;
  return {
    "reports/ccf_a_readiness_report.md": canonicalReadinessReportMarkdown(input),
    "reports/novelty_matrix.md": noveltyReport,
    "reports/related_work.md": canonicalRelatedWorkReportMarkdown(input, relatedWorkReport),
    "reports/evidence_ledger.md": canonicalEvidenceLedgerMarkdown(input),
    "plans/12_week_execution_plan.md": canonicalExecutionPlanMarkdown(input),
    "plans/experiment_plan.md": experimentPlan,
    "paper/abstract.md": paperAbstractMarkdown(input),
    "paper/related_work.md": paperRelatedWorkMarkdown(input, relatedWorkReport),
    "papers/papers.bib": referencesBib(verifiedPapers),
    "docs/idea/idea_brief.md": `# Idea Brief\n\n${JSON.stringify(input.ideaBrief, null, 2)}\n`,
    "docs/idea/assumptions.md": `# Assumptions\n\n${input.ideaBrief.assumptions.map((item) => `- ${item}`).join("\n")}\n`,
    "docs/relative_work/search_plan.json": JSON.stringify(input.searchPlan, null, 2) + "\n",
    "docs/relative_work/search_report.md": input.searchReport,
    "docs/relative_work/candidates.json": JSON.stringify(input.candidates, null, 2) + "\n",
    "docs/relative_work/triage_report.md": triageReport(evidenceBackedCandidates),
    "docs/reference/pdf_manifest.json": JSON.stringify(input.manifest, null, 2) + "\n",
    "docs/reference/paper_notes/README.md": "# Paper Notes\n\nNo PDFs have been read yet. Every future note must cite page, quote, and chunk id.\n",
    ...input.noteArtifacts,
    "docs/relative_work/related_work_matrix.csv": relatedWorkMatrixCsv(input.candidates, input.manifest, input.evidenceRows, input.chunks, { verifiedOnly: true }),
    "docs/reference/claim_evidence_matrix.csv": evidenceRowsCsv(input.evidenceRows, input.chunks),
    "docs/relative_work/topic_clusters.md": relatedWorkReport,
    "docs/relative_work/novelty_gap_matrix.md": noveltyReport,
    "docs/relative_work/collision_risk.md": `# Collision Risk\n\n${input.novelty.collision_risk}\n\n${input.novelty.reasons.map((reason) => `- ${reason}`).join("\n")}\n`,
    "docs/relative_work/baseline_recommendations.md": `# Baseline Recommendations\n\n${input.baselineRecommendations.length ? input.baselineRecommendations.map((item) => `- ${item}`).join("\n") : "- Blocked until verified PDF evidence identifies reviewer-expected baselines."}\n`,
    "docs/diagnosis/clarification_questions.md": clarificationQuestionsMarkdown(input.clarificationQuestions),
    "docs/reference/pdf_chunks.json": JSON.stringify(input.chunks, null, 2) + "\n",
    "docs/diagnosis/feasibility_report.md": feasibilityReport,
    "docs/diagnosis/reviewer_panel.md": agentReviewerPanelMarkdown(input.agentRelatedWork, input.agentNovelty, input.agentScore, input.agentFeasibility),
    "docs/proposal/experiment_plan.md": experimentPlan,
    "docs/proposal/revised_idea.md": revisedIdea,
    "docs/proposal/first_4_week_plan.md": firstFourWeekPlan,
    "docs/proposal/paper_story.md": paperStory,
    "docs/diagnosis/ccf_a_strict_scorecard.md": scorecard,
    ...input.templatePackage.files
  };
}

type PipelineArtifactInput = Parameters<typeof pipelineArtifacts>[0];

function canonicalReadinessReportMarkdown(input: PipelineArtifactInput): string {
  return `# CCF-A Readiness Report

## Idea Summary

${input.ideaBrief.idea_summary}

## Current Readiness

- Overall CCF-A readiness: ${input.score.total} / 100
- Confidence: ${input.score.confidence}
- Novelty collision risk: ${input.novelty.collision_risk}
- Verified evidence rows: ${input.evidenceRows.filter((row) => row.status === "verified").length}
- Candidate papers: ${input.candidates.length}
- Downloaded PDFs: ${input.manifest.filter((record) => record.status === "downloaded").length}

## Hard Blockers

${markdownList(input.score.hard_blockers)}

## Soft Weaknesses

${markdownList(input.score.soft_weaknesses)}

## Path To 70+

${numberedMarkdown(input.score.path_to_70)}

## Path To 80+

${numberedMarkdown(input.score.path_to_80)}

## Evidence Gate

- Baselines evidence-backed: ${input.baselineRecommendations.length ? "yes" : "no"}
- Datasets evidence-backed: ${input.datasetRecommendations.length ? "yes" : "no"}
- Metrics evidence-backed: ${input.metricRecommendations.length ? "yes" : "no"}

## Canonical Artifact Bundle

- \`reports/novelty_matrix.md\`
- \`reports/related_work.md\`
- \`reports/evidence_ledger.md\`
- \`plans/12_week_execution_plan.md\`
- \`plans/experiment_plan.md\`
- \`paper/main.tex\`
- \`paper/abstract.md\`
- \`paper/related_work.md\`
- \`papers/papers.bib\`

## Compatibility Mirrors

Legacy \`docs/...\` artifacts remain available for existing CLI and API consumers.
`;
}

function canonicalRelatedWorkReportMarkdown(input: PipelineArtifactInput, relatedWorkReport: string): string {
  const verifiedCount = verifiedPaperRecords(input.candidates, input.manifest, input.evidenceRows).length;
  return `# Related Work Report

## Candidate Summary

- Retrieved candidates: ${input.candidates.length}
- Verified PDF-backed papers: ${verifiedCount}
- Evidence-backed candidates used below: ${verifiedCount}

## Related Work Synthesis

${relatedWorkReport}

## Matrix Mirror

The compatibility CSV remains at \`docs/relative_work/related_work_matrix.csv\`.
`;
}

function canonicalEvidenceLedgerMarkdown(input: PipelineArtifactInput): string {
  const rows = input.evidenceRows.filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id);
  return `# Evidence Ledger

## Summary

- Verified page-level evidence rows: ${rows.length}
- Candidate papers: ${input.candidates.length}
- Downloaded PDFs: ${input.manifest.filter((record) => record.status === "downloaded").length}

## Evidence Rows

${rows.length ? rows.map((row) => `- ${row.paper_id} p.${row.page} [${row.claim_type}] ${row.claim}\n  - Quote: ${row.quote}\n  - Chunk: ${row.chunk_id}\n  - Confidence: ${row.confidence}`).join("\n") : "- No verified page-level evidence yet. Use `.idea2repo/evidence.jsonl` for structured rows once PDFs are read."}

## Compatibility Mirrors

- Structured ledger: \`.idea2repo/evidence.jsonl\`
- CSV mirror: \`docs/reference/claim_evidence_matrix.csv\`
- Paper notes: \`docs/reference/paper_notes/\`
`;
}

function canonicalExecutionPlanMarkdown(input: PipelineArtifactInput): string {
  const strategySteps = input.agentStrategy?.first_4_week_plan ?? [
    "Complete CCF-A venue-aware related-work verification.",
    "Acquire and read public PDFs with page-level evidence.",
    "Lock baseline, dataset, metric, and ablation design.",
    "Draft the paper story around the strongest evidence-backed novelty delta."
  ];
  return `# 12 Week Execution Plan

## Weeks 1-4: Evidence Lock

${numberedMarkdown(strategySteps)}

## Weeks 5-8: Experiments

1. Reproduce the strongest reviewer-expected baseline.
2. Run the first main-result experiment on the selected dataset or benchmark.
3. Add ablations for method components and failure cases.
4. Refresh the score snapshot after each evidence-producing milestone.

## Weeks 9-12: Paper And Release

1. Write the main paper sections from evidence-backed claims only.
2. Fill tables and figures with reproducible commands and artifact paths.
3. Run a reviewer-style weakness pass against novelty, soundness, and feasibility.
4. Package the venue template and prepare GitHub issue milestones.

## Current Blockers

${markdownList(input.score.hard_blockers)}
`;
}

function paperAbstractMarkdown(input: PipelineArtifactInput): string {
  return `# Abstract Draft

${input.ideaBrief.idea_summary}

This draft is intentionally evidence-gated. The current readiness score is ${input.score.total}/100 with confidence ${input.score.confidence}. Claims should not be promoted into the final abstract until the evidence ledger contains page-level quotes for novelty, baselines, datasets, metrics, and evaluation results.
`;
}

function paperRelatedWorkMarkdown(input: PipelineArtifactInput, relatedWorkReport: string): string {
  return `# Related Work Draft

This section must cite only verified entries from \`papers/papers.bib\` or \`paper/references.bib\`.

## Current Evidence Status

- Verified evidence rows: ${input.evidenceRows.filter((row) => row.status === "verified").length}
- Missing evidence items: ${input.score.score_dimensions.flatMap((dimension) => dimension.missingEvidence).length}

## Synthesis Notes

${relatedWorkReport}
`;
}

function numberedMarkdown(items: string[]): string {
  return items.length ? items.map((item, index) => `${index + 1}. ${item}`).join("\n") : "1. No action required under the current evidence gate.";
}

function searchPlanQueries(searchPlan: SearchPlan): string[] {
  return [
    ...searchPlan.precision_queries,
    ...searchPlan.recall_queries,
    ...searchPlan.baseline_queries,
    ...searchPlan.dataset_metric_queries,
    ...searchPlan.venue_queries,
    ...searchPlan.collision_queries
  ].map((entry) => entry.query);
}

function enforceSearchPlanGate(plan: SearchPlan, fallback: SearchPlan, warnings: string[]): SearchPlan {
  const precisionQueries = fillQueryGate(plan.precision_queries, fallback.precision_queries);
  const recallQueries = fillQueryGate(plan.recall_queries, fallback.recall_queries);
  if (plan.precision_queries.length < 5 || plan.recall_queries.length < 5) {
    warnings.push(`Search planning gate repaired: precision=${plan.precision_queries.length}, recall=${plan.recall_queries.length}; at least 5 of each are required.`);
  }
  return {
    ...plan,
    precision_queries: precisionQueries,
    recall_queries: recallQueries,
    baseline_queries: plan.baseline_queries.length ? plan.baseline_queries : fallback.baseline_queries,
    dataset_metric_queries: plan.dataset_metric_queries.length ? plan.dataset_metric_queries : fallback.dataset_metric_queries,
    venue_queries: plan.venue_queries.length ? plan.venue_queries : fallback.venue_queries,
    collision_queries: plan.collision_queries.length ? plan.collision_queries : fallback.collision_queries
  };
}

function fillQueryGate<T extends { query: string }>(queries: T[], fallback: T[]): T[] {
  const seen = new Set<string>();
  const merged = [...queries, ...fallback].filter((entry) => {
    const query = entry.query.trim().toLowerCase();
    if (!query || seen.has(query)) return false;
    seen.add(query);
    return true;
  });
  return merged.slice(0, Math.max(5, queries.length));
}

function stageArtifactPaths(id: Parameters<typeof markStage>[1], extraArtifacts: string[] = []): string[] {
  const stage = researchStages.find((candidate) => candidate.id === id);
  return [...new Set([...(stage?.artifactPaths ?? []), ...extraArtifacts])];
}

function decisionEvidenceRef(ref: { artifact: string; page?: number; quote?: string; chunk_id?: string }): string {
  return [ref.artifact, ref.page ? `page:${ref.page}` : "", ref.chunk_id ? `chunk:${ref.chunk_id}` : ""].filter(Boolean).join("#");
}

async function readJsonArtifact<T>(readArtifact: (relativePath: string) => Promise<string | null>, relativePath: string): Promise<T | null> {
  const content = await readArtifact(relativePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readArtifacts(readArtifact: (relativePath: string) => Promise<string | null>, relativePaths: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const relativePath of relativePaths) {
    const content = await readArtifact(relativePath);
    if (content !== null) files[relativePath] = content;
  }
  return files;
}

function preservedPaperNoteArtifacts(artifacts: Record<string, string>, trustedPaths: Set<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(artifacts).filter(([path]) => trustedPaths.has(path))
  );
}

function preservableOutputArtifacts(artifacts: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(artifacts).filter(([path]) => path !== "docs/relative_work/triage_report.md")
  );
}

async function paperNotesFromArtifacts(readArtifact: (relativePath: string) => Promise<string | null>, chunks: PdfChunkIndexEntry[], trustedPaths: Set<string>): Promise<PdfPaperNote[]> {
  const byPaper = new Map<string, PdfChunkIndexEntry[]>();
  for (const chunk of chunks) byPaper.set(chunk.paper_id, [...(byPaper.get(chunk.paper_id) ?? []), chunk]);
  const notes: PdfPaperNote[] = [];
  for (const [paperId, paperChunks] of byPaper) {
    const notePath = `docs/reference/paper_notes/${paperId}.md`;
    const noteArtifact = await readArtifact(notePath);
    if (!noteArtifact) continue;
    const evidenceRefs = paperNoteEvidenceRefs(noteArtifact, paperChunks);
    if (!evidenceRefs.length) continue;
    trustedPaths.add(notePath);
    const text = noteArtifact.slice(0, 1600);
    notes.push({
      paper_id: paperId,
      title_verified: false,
      summary: text || "Resumed from existing paper-note artifact.",
      main_problem: extractMarkdownSection(noteArtifact, "Problem") || "Recovered from existing paper-note artifact.",
      core_method: extractMarkdownSection(noteArtifact, "Method") || "Recovered from existing paper-note artifact.",
      main_claims: evidenceRefs.map((ref) => ({
        claim: "Recovered verified paper-note artifact for resumed analysis.",
        evidence_quote: ref.quote,
        page: ref.page,
        confidence: "low" as const
      })),
      datasets: [],
      baselines: [],
      metrics: [],
      strengths: [],
      weaknesses: [],
      limitations: [extractMarkdownSection(noteArtifact, "Limitations") || "Resume used existing paper-note artifact without original staged-agent JSON."],
      relevance_to_current_idea: "Recovered from existing paper-note artifact.",
      difference_from_current_idea: "Unknown until related-work analysis is rerun.",
      collision_risk: "medium" as const,
      useful_for: ["resume"],
      unreadable_or_missing_parts: []
    });
  }
  return notes;
}

function paperNoteArtifacts(notes: PdfPaperNote[], chunks: PdfChunkIndexEntry[]): Record<string, string> {
  const chunksByPaper = new Map<string, PdfChunkIndexEntry[]>();
  for (const chunk of chunks) chunksByPaper.set(chunk.paper_id, [...(chunksByPaper.get(chunk.paper_id) ?? []), chunk]);
  return Object.fromEntries(notes.map((note) => [`docs/reference/paper_notes/${note.paper_id}.md`, paperNoteMarkdown(note, chunksByPaper.get(note.paper_id) ?? [])]));
}

function paperNoteMarkdown(note: PdfPaperNote, chunks: PdfChunkIndexEntry[]): string {
  const evidence = note.main_claims.flatMap((claim) => {
    const chunk = evidenceChunkForClaim(claim, chunks);
    if (!chunk) return [];
    return `- Claim: ${claim.claim}
  - Page: ${claim.page}
  - Quote: ${claim.evidence_quote}
  - Chunk: ${chunk.chunk_id}
  - Confidence: ${claim.confidence}`;
  });
  return `# ${note.paper_id}

## Problem

${note.main_problem}

## Method

${note.core_method}

## Summary

${note.summary}

## Claims And Evidence

${evidence.join("\n") || "- No verified claims extracted."}

## Datasets

${markdownList(note.datasets)}

## Baselines

${markdownList(note.baselines)}

## Metrics

${markdownList(note.metrics)}

## Limitations

${markdownList(note.limitations)}

## Relevance

${note.relevance_to_current_idea}

## Difference

${note.difference_from_current_idea}
`;
}

function paperNoteEvidenceRefs(markdown: string, chunks: PdfChunkIndexEntry[]): Array<{ page: number; quote: string; chunk_id: string }> {
  const chunksById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const refs: Array<{ page: number; quote: string; chunk_id: string }> = [];
  const pattern = /Page:\s*(\d+)[\s\S]*?Quote:\s*(?!missing\b)([^\n]+)[\s\S]*?Chunk:\s*(?!missing\b)([^\s\n]+)/gi;
  for (const match of markdown.matchAll(pattern)) {
    const page = Number(match[1]);
    const quote = match[2]?.trim() ?? "";
    const chunk_id = match[3]?.trim() ?? "";
    const chunk = chunksById.get(chunk_id);
    if (!page || !quote || !chunk || chunk.page !== page || !textContainsQuote(chunk.text, quote)) continue;
    refs.push({ page, quote, chunk_id });
  }
  return refs;
}

function verifiedPaperNotesAgainstChunks(notes: PdfPaperNote[], chunks: PdfChunkIndexEntry[]): PdfPaperNote[] {
  const chunksByPaper = new Map<string, PdfChunkIndexEntry[]>();
  for (const chunk of chunks) chunksByPaper.set(chunk.paper_id, [...(chunksByPaper.get(chunk.paper_id) ?? []), chunk]);
  const verified: PdfPaperNote[] = [];
  for (const note of notes) {
    const paperChunks = chunksByPaper.get(note.paper_id) ?? [];
    const mainClaims = note.main_claims.filter((claim) => evidenceChunkForClaim(claim, paperChunks));
    if (!mainClaims.length) continue;
    verified.push({ ...note, main_claims: mainClaims });
  }
  return verified;
}

function evidenceChunkForClaim(claim: PdfPaperNote["main_claims"][number], chunks: PdfChunkIndexEntry[]): PdfChunkIndexEntry | null {
  return chunks.find((chunk) => chunk.page === claim.page && textContainsQuote(chunk.text, claim.evidence_quote)) ?? null;
}

function textContainsQuote(text: string, quote: string): boolean {
  const normalizedText = normalizeEvidenceText(text);
  const normalizedQuote = normalizeEvidenceText(quote);
  return Boolean(normalizedQuote) && normalizedText.includes(normalizedQuote);
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const pattern = new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?:\\n\\n## |$)`, "i");
  return pattern.exec(markdown)?.[1]?.trim() ?? "";
}

function parseIdeaBriefArtifact(markdown: string): IdeaBrief | null {
  const start = markdown.indexOf("{");
  const end = markdown.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(markdown.slice(start, end + 1)) as IdeaBrief;
  } catch {
    return null;
  }
}

function createStagedAgent(options: ResearchPipelineOptions): StagedResearchAgent | null {
  if (options.agentClient) return options.agentClient;
  if (options.provider === OFFLINE_PROVIDER_ID || (!options.allowNetwork && options.provider !== CODEX_CLI_PROVIDER_ID)) return null;
  const provider = canonicalProvider(options.provider, false);
  return new AdapterStagedResearchAgent(createProviderAdapter(provider), options);
}

class AdapterStagedResearchAgent implements StagedResearchAgent {
  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly options: ResearchPipelineOptions
  ) {}

  async intakeIdea(
    idea: string,
    context: { requestedDomains?: string[]; targetVenues?: string[]; timelineWeeks?: number; resources?: string[] } = {},
    progress?: (message: string) => void
  ): Promise<{ idea_brief: IdeaBrief; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const ideaBrief = await this.structured("IdeaBrief", IdeaBriefSchema, validateIdeaBrief, "00_intake_router.md", "Convert the idea into a precise search-ready research brief.", { idea, ...context }, progress);
    return this.result({ idea_brief: ideaBrief });
  }

  async planLiteratureSearch(
    idea: string,
    context: { requestedDomains?: string[]; targetVenues?: string[]; timelineWeeks?: number; resources?: string[] } = {},
    progress?: (message: string) => void
  ): Promise<{ search_plan: SearchPlan; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const searchPlan = await this.structured("SearchPlan", SearchPlanSchema, validateSearchPlan, "01_search_planner.md", "Plan literature search queries for the idea.", { idea, ...context }, progress);
    return this.result({ search_plan: searchPlan });
  }

  async triagePaperCandidates(
    idea: string,
    candidates: unknown[],
    progress?: (message: string) => void
  ): Promise<{ triage: CandidateTriage; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const triage = await this.structured("CandidateTriage", CandidateTriageSchema, validateCandidateTriage, "02_candidate_triage.md", "Triage paper candidates before novelty judgment.", { idea, candidates }, progress);
    return this.result({ triage });
  }

  async readPaperPdf(
    idea: string,
    paper: unknown,
    chunks: unknown[],
    progress?: (message: string) => void
  ): Promise<{ paper_note: PdfPaperNote; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const paperNote = await this.structured("PdfPaperNote", PdfPaperNoteSchema, validatePdfPaperNote, "03_pdf_paper_reader.md", "Read parsed PDF chunks and extract evidence only from the chunks.", { idea, paper, chunks }, progress);
    return this.result({ paper_note: paperNote });
  }

  async analyzeRelatedWork(
    idea: string,
    paperNotes: unknown[],
    progress?: (message: string) => void
  ): Promise<{ related_work: RelatedWorkAnalysis; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const relatedWork = await this.structured("RelatedWorkAnalysis", RelatedWorkAnalysisSchema, validateRelatedWorkAnalysis, "04_related_work_analyst.md", "Synthesize verified paper notes into a related-work map.", { idea, paper_notes: paperNotes }, progress);
    return this.result({ related_work: relatedWork });
  }

  async analyzeNovelty(
    idea: string,
    relatedWork: unknown,
    progress?: (message: string) => void
  ): Promise<{ novelty: NoveltyGapAnalysis; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const novelty = await this.structured("NoveltyGapAnalysis", NoveltyGapAnalysisSchema, validateNoveltyGapAnalysis, "05_novelty_gap_analyst.md", "Compare the idea against verified related work and identify defensible gaps.", { idea, related_work: relatedWork }, progress);
    return this.result({ novelty });
  }

  async scoreCcfA(
    idea: string,
    evidence: unknown,
    progress?: (message: string) => void
  ): Promise<{ scorecard: StrictCcfAReview; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const scorecard = await this.structured("StrictCcfAReview", StrictCcfAReviewSchema, validateStrictCcfAReview, "06_ccf_a_reviewer.md", "Apply the strict CCF-A evidence rubric and cap rules.", { idea, evidence }, progress);
    return this.result({ scorecard });
  }

  async reviewFeasibility(
    idea: string,
    constraints: unknown,
    progress?: (message: string) => void
  ): Promise<{ feasibility: FeasibilityReview; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const feasibility = await this.structured("FeasibilityReview", FeasibilityReviewSchema, validateFeasibilityReview, "07_feasibility_reviewer.md", "Review feasibility under the provided time and resource constraints.", { idea, constraints }, progress);
    return this.result({ feasibility });
  }

  async refineIdea(
    idea: string,
    reviewContext: unknown,
    progress?: (message: string) => void
  ): Promise<{ strategy: ResearchStrategy; provider_id: string; api_shape: string; codex_model: string; events: unknown[] }> {
    const strategy = await this.structured("ResearchStrategy", ResearchStrategySchema, validateResearchStrategy, "08_research_strategist.md", "Propose a revised defensible research direction after strict review.", { idea, review_context: reviewContext }, progress);
    return this.result({ strategy });
  }

  private async structured<T>(
    schemaName: string,
    outputSchema: object,
    validate: (value: unknown) => T,
    promptFile: Parameters<ProviderAdapter["structured"]>[0]["promptFile"],
    task: string,
    context: unknown,
    progress?: (message: string) => void
  ): Promise<T> {
    return await this.adapter.structured({
      task,
      promptFile,
      context,
      schemaName,
      outputSchema,
      validate,
      model: this.options.model ?? undefined,
      reasoningEffort: this.options.reasoningEffort ?? undefined,
      events: this.options.events,
      progress,
      signal: this.options.signal
    });
  }

  private result<T extends Record<string, unknown>>(payload: T): T & { provider_id: string; api_shape: string; codex_model: string; events: unknown[] } {
    return {
      ...payload,
      provider_id: this.adapter.id,
      api_shape: apiShapeForProvider(this.adapter.id),
      codex_model: this.options.model ?? "",
      events: []
    };
  }
}

async function stagedOrFallback<T>(run: () => Promise<T> | undefined, fallback: () => T | Promise<T>, warnings: string[], label: string, signal?: AbortSignal): Promise<T> {
  const request = run();
  if (!request) return await fallback();
  try {
    return await request;
  } catch (error) {
    throwIfAborted(signal);
    warnings.push(`Staged agent ${label} fell back to deterministic implementation: ${error instanceof Error ? error.message : String(error)}`);
    return await fallback();
  }
}

async function readPaperNotesWithAgent(
  agent: StagedResearchAgent | null,
  idea: string,
  chunks: PdfChunkIndexEntry[],
  warnings: string[],
  progress?: (message: string) => void,
  signal?: AbortSignal
): Promise<PdfPaperNote[]> {
  if (!agent || !chunks.length) return [];
  const byPaper = new Map<string, PdfChunkIndexEntry[]>();
  for (const chunk of chunks) byPaper.set(chunk.paper_id, [...(byPaper.get(chunk.paper_id) ?? []), chunk]);
  const notes: PdfPaperNote[] = [];
  for (const [paperId, paperChunks] of byPaper) {
    const note = await stagedOrFallback(
      () => agent.readPaperPdf(idea, { paper_id: paperId }, paperChunks, progress).then((result) => result.paper_note),
      () => null,
      warnings,
      `PDF reader ${paperId}`,
      signal
    );
    if (note) notes.push(note);
  }
  return notes;
}

async function templatePackageArtifacts(
  input: { idea: string; projectName: string; venue?: string; domain?: string; strict?: boolean },
  toolRegistry: ToolRegistry,
  toolContext: ToolContext
): Promise<PipelineTemplatePackage> {
  const resolveInput: TemplateResolveInput = { venue: input.venue, domain: input.domain, mode: "review" };
  const resolved = await toolRegistry.execute<TemplateResolveInput, TemplateResolveResult>("template.resolve", resolveInput, toolContext);
  const renderInput: PaperRenderInput = {
    profile: resolved.profile,
    projectName: input.projectName,
    title: titleFromIdea(input.idea),
    anonymous: resolved.profile.default_review_mode === "anonymous",
    reviewMode: resolved.profile.default_review_mode,
    bibFile: "references.bib",
    macrosFile: "macros.tex"
  };
  const rendered = await toolRegistry.execute<PaperRenderInput, PaperRenderResult>("template.render", renderInput, toolContext);
  const files: Record<string, string> = {
    ...rendered.files,
    "docs/submission/target_venue.md": `# Target Venue\n\n${input.venue ?? resolved.profile.venue_name}\n`,
    "docs/submission/venue_template_profile.json": JSON.stringify(resolved.profile, null, 2) + "\n",
    "docs/submission/template_decision.md": templateDecisionMarkdown(resolved, resolveInput),
    "docs/submission/submission_checklist.md": `# Submission Checklist\n\n- [x] Template profile selected: ${resolved.profile.profile_id}\n- [ ] Official CFP and style files verified for target year\n- [x] Anonymous mode checked\n- [x] Static compliance checked\n`,
    "docs/submission/camera_ready_todo.md": "# Camera Ready TODO\n\nPrepare author blocks, artifact links, rights blocks, and final venue metadata after acceptance.\n"
  };
  const compliance = await toolRegistry.execute<{ profile: TemplateResolveResult["profile"]; anonymous: boolean; strict?: boolean; artifacts: Record<string, string> }, TemplateComplianceResult>("template.check", {
    profile: resolved.profile,
    anonymous: resolved.profile.default_review_mode === "anonymous",
    strict: input.strict,
    artifacts: files
  }, toolContext);
  files["docs/submission/template_compliance_report.md"] = complianceMarkdown(compliance);
  files["docs/submission/anonymity_check.md"] = anonymityMarkdown(compliance);
  files["paper/submission/overleaf.zip"] = zipArtifactString(createZipArchive(overleafZipEntries(files)));
  files["paper/submission/submission.zip"] = zipArtifactString(createZipArchive(submissionZipEntries(files)));
  return {
    files
  };
}

function overleafZipEntries(files: Record<string, string>): ZipEntry[] {
  return Object.entries(files)
    .filter(([path]) => path.startsWith("paper/") && !path.startsWith("paper/submission/") && !path.startsWith("paper/build/"))
    .map(([path, data]) => ({ path: path.replace(/^paper\//, ""), data }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function submissionZipEntries(files: Record<string, string>): ZipEntry[] {
  return Object.entries(files)
    .filter(([path]) => (path.startsWith("paper/") && !path.startsWith("paper/submission/")) || path.startsWith("docs/submission/"))
    .map(([path, data]) => ({ path, data }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function zipArtifactString(buffer: Buffer): string {
  return buffer.toString("latin1");
}

function agentTriageMarkdown(triage: CandidateTriage): string {
  return `# Candidate Triage

## Must Read Core Papers

${markdownList(triage.must_read_core_papers)}

## Expanded Papers

${markdownList(triage.expanded_papers)}

## Baselines

${markdownList(triage.baselines)}

## Missing Search Areas

${markdownList(triage.missing_search_areas)}

## Rationale

${triage.rationale}
`;
}

function agentRelatedWorkMarkdown(related: RelatedWorkAnalysis): string {
  return `# Topic Clusters

## Reviewer Expected Baselines

${markdownList(related.reviewer_expected_baselines)}

## Evaluation Conventions

${markdownList(related.evaluation_conventions)}

## Evidence Warnings

${markdownList(related.evidence_warnings)}
`;
}

function agentNoveltyMarkdown(novelty: NoveltyGapAnalysis): string {
  return `# Novelty Gap Matrix

- Collision risk: ${novelty.collision_risk}
- Defensible gap: ${novelty.defensible_gap}

## Collision Reasons

${markdownList(novelty.collision_reasons)}

## Novelty Gaps

${markdownList(novelty.novelty_gaps)}

## Evidence Warnings

${markdownList(novelty.evidence_warnings)}
`;
}

function agentFeasibilityMarkdown(feasibility: FeasibilityReview): string {
  return `# Feasibility Report

- Timeline: ${feasibility.timeline_weeks} weeks
- Verdict: ${feasibility.verdict}

## Feasible MVP

${markdownList(feasibility.feasible_mvp)}

## Ambitious Extensions

${markdownList(feasibility.ambitious_extensions)}

## Risks

${markdownList(feasibility.risks)}

## Unavailable Resources

${markdownList(feasibility.unavailable_resource_warnings)}
`;
}

function agentReviewerPanelMarkdown(related: RelatedWorkAnalysis | null, novelty: NoveltyGapAnalysis | null, score: StrictCcfAReview | null, feasibility: FeasibilityReview | null): string {
  return `# Reviewer Panel

## Related Work Reviewer

${related ? markdownList(related.evidence_warnings) : "- Requires verified paper notes before final judgment."}

## Novelty Reviewer

${novelty ? markdownList(novelty.collision_reasons) : "- Novelty judgment is evidence-gated."}

## Soundness Reviewer

${score ? markdownList(score.cap_reasons) : "- Strict score uses deterministic caps until agent review is available."}

## Feasibility Reviewer

${feasibility ? feasibility.verdict : "Feasibility modeled by deterministic fallback."}
`;
}

function agentStrategyRevisedIdeaMarkdown(strategy: ResearchStrategy): string {
  return `# Revised Idea

## Revised Direction

${strategy.revised_idea}

## Central Hypothesis

${strategy.central_hypothesis}

## Baselines

${markdownList(strategy.baselines)}

## Datasets

${markdownList(strategy.datasets)}

## Metrics

${markdownList(strategy.metrics)}
`;
}

function agentFirstFourWeekPlanMarkdown(strategy: ResearchStrategy): string {
  return `# First 4 Week Plan

${strategy.first_4_week_plan.map((item, index) => `${index + 1}. ${item}`).join("\n") || "1. Complete evidence-gated related work."}
`;
}

function agentScoreMarkdown(score: StrictCcfAReview): string {
  return `- Agent total: ${score.total} / 100
- Cap reasons: ${score.cap_reasons.join("; ") || "none"}
- Recommendations: ${score.recommendations.join("; ") || "none"}
`;
}

function verifiedEvidencePaperCount(rows: ReturnType<typeof extractEvidenceRows>): number {
  return new Set(rows.filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id).map((row) => row.paper_id)).size;
}

function verifiedPaperRecords(candidates: PaperCandidate[], manifest: PdfManifestRecord[], rows: ReturnType<typeof extractEvidenceRows>): PaperRecord[] {
  const manifestByPaper = new Map(manifest.map((record) => [record.paper_id, record]));
  const rowsByPaper = new Map<string, ReturnType<typeof extractEvidenceRows>>();
  for (const row of rows.filter((candidate) => candidate.status === "verified" && candidate.page && candidate.quote && candidate.chunk_id)) {
    rowsByPaper.set(row.paper_id, [...(rowsByPaper.get(row.paper_id) ?? []), row]);
  }
  const verified: PaperRecord[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const paperId = safePaperId(candidate.candidate_id);
    const record = manifestByPaper.get(paperId);
    const evidence = rowsByPaper.get(paperId);
    if (record?.status !== "downloaded" || !record.pdf_path || !record.pdf_sha256 || !evidence?.length) continue;
    verified.push({
      ...paperCandidateToRecord(candidate, index),
      paper_id: paperId,
      pdf_path: record.pdf_path,
      pdf_sha256: record.pdf_sha256,
      pdf_status: record.status,
      evidence_refs: evidence.map((row) => ({
        page: Number(row.page),
        quote: row.quote!,
        chunk_id: row.chunk_id!,
        purpose: row.claim
      })),
      analysis_confidence: "medium"
    });
  }
  return verified;
}

function triageReport(candidates: PaperCandidate[]): string {
  return `# Candidate Triage

- Candidates: ${candidates.length}
- Must-read direct prior work target: ${Math.min(8, candidates.length)}
- Expanded paper target: ${Math.min(30, Math.max(15, candidates.length))}

${candidates.slice(0, 20).map((candidate, index) => `- ${index + 1}. ${candidate.title} (${candidate.year ?? "n.d."}) — ${candidate.confidence}; ${candidate.ccf_rank ?? "unknown"}; ${candidate.track_status ?? "unknown"}; ${candidate.reason ?? "no enrichment reason"}`).join("\n") || "- No candidates collected yet."}
`;
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}

function isResearchStageId(value: string | undefined): value is ResearchStageId {
  return Boolean(value && researchStages.some((stage) => stage.id === value));
}

function titleFromIdea(idea: string): string {
  const words = idea.replace(/[^a-zA-Z0-9\s-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 10);
  return words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(" ") || "Evidence-First Research Draft";
}

function markdownList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function seedTerms(idea: string): string[] {
  return [
    ...new Set(
      idea
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 2)
        .filter((word) => !["with", "from", "that", "this", "into", "using", "and", "the", "for"].includes(word))
    )
  ].slice(0, 16);
}

function compactSentence(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ").slice(0, 400);
}
