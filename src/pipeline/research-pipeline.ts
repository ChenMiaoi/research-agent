import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidateTriage, FeasibilityReview, IdeaBrief, NoveltyGapAnalysis, PdfPaperNote, RelatedWorkAnalysis, ResearchStrategy, SearchPlan, StrictCcfAReview } from "../agents/schemas.js";
import { CodexOAuthClient } from "../auth/codex-oauth.js";
import { paperCandidateToRecord, type PaperRecord } from "../literature.js";
import { diagnoseIdea } from "../scoring.js";
import { exists } from "../state.js";
import { evidenceRowsCsv, evidenceRowsMarkdown, evidenceText, extractEvidenceRows } from "../skills/analysis/evidence-extract.js";
import { strictCcfAScore, strictScoreMarkdown } from "../skills/analysis/ccf-a-score.js";
import { experimentPlanMarkdown, feasibilityMarkdown, revisedIdeaMarkdown } from "../skills/analysis/idea-refine.js";
import { assessNovelty, noveltyMatrixMarkdown } from "../skills/analysis/novelty-matrix.js";
import { relatedWorkMatrixCsv, topicClustersMarkdown } from "../skills/analysis/related-work-matrix.js";
import { searchLiteratureAsync } from "../literature.js";
import type { LiteratureSource, PaperCandidate } from "../skills/literature/types.js";
import { acquirePdfs } from "../skills/pdf/acquire.js";
import { buildPdfChunkIndex, type PdfChunkIndexEntry } from "../skills/pdf/chunk.js";
import type { PdfManifestRecord } from "../skills/pdf/provenance.js";
import { pdfChunksEqual, validateDownloadedPdfManifest } from "../skills/pdf/trust.js";
import { anonymityMarkdown, checkTemplateComplianceArtifacts, complianceMarkdown } from "../skills/templates/compliance.js";
import { createZipArchive, type ZipEntry } from "../skills/templates/package.js";
import { resolveTemplateProfile, templateDecisionMarkdown } from "../skills/templates/resolve.js";
import { renderPaper } from "../skills/templates/render.js";
import type { TemplateResolveInput } from "../skills/templates/types.js";
import { runtimeTimestamp, type EventSink, type Idea2RepoEvent } from "../runtime/events.js";
import { createResearchPipelineState, markStage, readResearchPipelineState, writeResearchPipelineState, type ResearchPipelineState } from "./stage-state.js";
import { researchStages } from "./stages.js";

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
  progress?: (message: string) => void;
};

export type ResearchPipelineResult = {
  state: ResearchPipelineState;
  ideaBrief: IdeaBrief;
  searchPlan: SearchPlan;
  verifiedPapers: PaperRecord[];
  baselineRecommendations: string[];
  datasetRecommendations: string[];
  metricRecommendations: string[];
  claimEvidenceRows: Record<string, string>[];
  artifacts: Record<string, string>;
  warnings: string[];
};

export async function runResearchPipeline(idea: string, options: ResearchPipelineOptions = {}): Promise<ResearchPipelineResult> {
  if (!idea.trim()) throw new Error("idea must not be empty");
  const outputRoot = options.outputRoot ?? process.cwd();
  const restoredState = options.outputRoot ? await readResearchPipelineState(outputRoot) : null;
  if (restoredState && restoredState.idea !== idea) throw new Error(`research pipeline state belongs to a different idea: ${restoredState.idea}`);
  let state = restoredState ?? createResearchPipelineState(idea, options.outputRoot);
  const runId = options.runId ?? randomUUID();
  const warnings: string[] = [];
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
  const emitRuntimeEvent = async (event: Idea2RepoEvent): Promise<void> => {
    await options.events?.emit(event);
  };
  const setStage = async (id: Parameters<typeof markStage>[1], status: Parameters<typeof markStage>[2], error?: string): Promise<void> => {
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
  await emitRuntimeEvent({ type: "run.started", run_id: runId, idea, output_root: outputRoot, timestamp: runtimeTimestamp() });
  try {
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
      "idea intake"
    );
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
      "search planning"
    );
    searchPlan = enforceSearchPlanGate(searchPlan, offlineSearchPlan(ideaBrief, options.maxPapers ?? 20), warnings);
    await setStage("search_planning", "completed");
  }
  searchPlan = enforceSearchPlanGate(searchPlan, offlineSearchPlan(ideaBrief, options.maxPapers ?? 20), warnings);

  let candidates: PaperCandidate[];
  let searchReport: string;
  const resumedCandidates = await readJsonArtifact<PaperCandidate[]>(readArtifact, "docs/relative_work/candidates.json");
  if ((await canResumeStage("literature_search")) && resumedCandidates) {
    candidates = resumedCandidates;
    searchReport = (await readArtifact("docs/relative_work/search_report.md")) ?? "# Literature Search Report\n\nResumed from candidate artifacts.\n";
  } else {
    await setStage("literature_search", "running");
    const queries = searchPlanQueries(searchPlan);
    const literature = await searchLiteratureAsync({
      queries,
      allowNetwork: Boolean(options.allowNetwork),
      limit: options.maxPapers ?? 20,
      idea,
      sources: options.sources as LiteratureSource[] | undefined
    });
    warnings.push(...literature.warnings);
    candidates = literature.candidates;
    searchReport = literature.search_report;
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
          "candidate triage"
        )
      : null;
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
    manifest = await acquirePdfs(candidates, {
      outputRoot,
      allowNetwork: Boolean(options.allowNetwork),
      downloadPdfs: Boolean(options.downloadPdfs)
    });
    await setStage("pdf_acquisition", candidates.length ? "completed" : "skipped", candidates.length ? undefined : "No candidates available for PDF acquisition.");
  }

  let chunks: PdfChunkIndexEntry[];
  let agentPaperNotes: PdfPaperNote[] = [];
  const resumedChunks = await readJsonArtifact<PdfChunkIndexEntry[]>(readArtifact, "docs/reference/pdf_chunks.json");
  const parsedManifestChunks = manifest.length ? await buildPdfChunkIndex(outputRoot, manifest) : [];
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
    agentPaperNotes = verifiedPaperNotesAgainstChunks(await readPaperNotesWithAgent(agent, idea, chunks, warnings, options.progress), chunks);
    await setStage("pdf_reading", chunks.length ? "completed" : "skipped", chunks.length ? undefined : "No downloaded PDFs were available for reading.");
  }

  const evidenceRows = extractEvidenceRows(chunks);
  const verifiedEvidenceRows = evidenceRows.filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id);
  const hasVerifiedPdfEvidence = verifiedEvidenceRows.length > 0;
  const noteArtifacts = { ...evidenceRowsMarkdown(evidenceRows), ...paperNoteArtifacts(agentPaperNotes, chunks) };
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
            "related work analysis"
          )
        : null;
    await setStage("related_work_analysis", agentRelatedWork ? "completed" : "skipped", agentRelatedWork ? undefined : "No verified paper notes are available for related-work agent analysis.");
    relatedWorkAvailable = Boolean(agentRelatedWork);
  }

  const novelty = assessNovelty(idea, candidates, evidenceRows);
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
            "novelty analysis"
          )
        : null;
    await setStage("novelty_analysis", agentNovelty ? "completed" : "skipped", agentNovelty ? undefined : "Verified related-work analysis is required before novelty agent analysis.");
    noveltyAvailable = Boolean(agentNovelty);
  }

  const verifiedPaperCount = verifiedEvidencePaperCount(evidenceRows);
  const evidence = evidenceText(evidenceRows);
  const score = strictCcfAScore({
    verifiedRelatedWorkCount: verifiedPaperCount,
    pdfReadCount: new Set(chunks.map((chunk) => chunk.paper_id)).size,
    corePaperCount: verifiedPaperCount,
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
          "strict CCF-A scoring"
        )
      : null;
    await setStage("ccf_a_strict_scoring", "completed");
  } else {
    await preserveStageArtifacts("ccf_a_strict_scoring");
  }

  let agentFeasibility: FeasibilityReview | null = null;
  if (!(await canResumeStage("feasibility_review"))) {
    await setStage("feasibility_review", "running");
    agentFeasibility = await stagedOrFallback(
      () => agent?.reviewFeasibility(idea, { timelineWeeks: options.timelineWeeks ?? 12, resources: options.resources ?? [] }, options.progress).then((result) => result.feasibility),
      () => null,
      warnings,
      "feasibility review"
    );
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
      required_evidence: "At least one result table linked to verified baseline, dataset, and metric.",
      planned_artifact: "results/tables/main_results.csv",
      status: "planned"
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
          "research strategy"
        )
      : null;
    await setStage("better_idea_synthesis", agentStrategy ? "completed" : "skipped", agentStrategy ? undefined : "Research strategy is blocked until verified related work and novelty analysis exist.");
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
    ...preservedOutputArtifacts,
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
    warnings: [...warnings, ...(options.allowNetwork ? [] : ["Network disabled; literature candidates require a later search stage."])]
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
    await emitRuntimeEvent({ type: "run.failed", run_id: runId, error: message, timestamp: runtimeTimestamp() });
    throw error;
  }
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
  score: ReturnType<typeof strictCcfAScore>;
  searchReport: string;
  baselineRecommendations: string[];
  datasetRecommendations: string[];
  metricRecommendations: string[];
  claimEvidenceRows: Record<string, string>[];
  strict: boolean;
  agentTriage: CandidateTriage | null;
  agentRelatedWork: RelatedWorkAnalysis | null;
  agentNovelty: NoveltyGapAnalysis | null;
  agentScore: StrictCcfAReview | null;
  agentFeasibility: FeasibilityReview | null;
  agentStrategy: ResearchStrategy | null;
  templatePackage: PipelineTemplatePackage;
}): Record<string, string> {
  return {
    "docs/idea/idea_brief.md": `# Idea Brief\n\n${JSON.stringify(input.ideaBrief, null, 2)}\n`,
    "docs/idea/assumptions.md": `# Assumptions\n\n${input.ideaBrief.assumptions.map((item) => `- ${item}`).join("\n")}\n`,
    "docs/relative_work/search_plan.json": JSON.stringify(input.searchPlan, null, 2) + "\n",
    "docs/relative_work/search_report.md": input.searchReport,
    "docs/relative_work/candidates.json": JSON.stringify(input.candidates, null, 2) + "\n",
    "docs/relative_work/triage_report.md": input.agentTriage ? agentTriageMarkdown(input.agentTriage) : triageReport(input.candidates),
    "docs/reference/pdf_manifest.json": JSON.stringify(input.manifest, null, 2) + "\n",
    "docs/reference/paper_notes/README.md": "# Paper Notes\n\nNo PDFs have been read yet. Every future note must cite page, quote, and chunk id.\n",
    ...input.noteArtifacts,
    "docs/relative_work/related_work_matrix.csv": relatedWorkMatrixCsv(input.candidates, input.manifest, input.evidenceRows),
    "docs/reference/claim_evidence_matrix.csv": evidenceRowsCsv(input.evidenceRows),
    "docs/relative_work/topic_clusters.md": input.agentRelatedWork ? agentRelatedWorkMarkdown(input.agentRelatedWork) : topicClustersMarkdown(input.candidates),
    "docs/relative_work/novelty_gap_matrix.md": input.agentNovelty ? agentNoveltyMarkdown(input.agentNovelty) : noveltyMatrixMarkdown(input.novelty),
    "docs/relative_work/collision_risk.md": `# Collision Risk\n\n${input.novelty.collision_risk}\n\n${input.novelty.reasons.map((reason) => `- ${reason}`).join("\n")}\n`,
    "docs/relative_work/baseline_recommendations.md": `# Baseline Recommendations\n\n${input.baselineRecommendations.length ? input.baselineRecommendations.map((item) => `- ${item}`).join("\n") : "- Blocked until verified PDF evidence identifies reviewer-expected baselines."}\n`,
    "docs/reference/pdf_chunks.json": JSON.stringify(input.chunks, null, 2) + "\n",
    "docs/diagnosis/feasibility_report.md": input.agentFeasibility ? agentFeasibilityMarkdown(input.agentFeasibility) : feasibilityMarkdown(input.ideaBrief.resource_constraints, 12),
    "docs/diagnosis/reviewer_panel.md": agentReviewerPanelMarkdown(input.agentRelatedWork, input.agentNovelty, input.agentScore, input.agentFeasibility),
    "docs/proposal/experiment_plan.md": `${experimentPlanMarkdown()}\n## Evidence Status\n\n- Baselines evidence-backed: ${input.baselineRecommendations.length ? "yes" : "no"}\n- Datasets evidence-backed: ${input.datasetRecommendations.length ? "yes" : "no"}\n- Metrics evidence-backed: ${input.metricRecommendations.length ? "yes" : "no"}\n`,
    "docs/proposal/revised_idea.md": input.agentStrategy ? agentStrategyRevisedIdeaMarkdown(input.agentStrategy) : revisedIdeaMarkdown(input.idea, input.novelty, input.score),
    "docs/proposal/first_4_week_plan.md": input.agentStrategy ? agentFirstFourWeekPlanMarkdown(input.agentStrategy) : "# First 4 Week Plan\n\n1. Plan search and triage candidates.\n2. Acquire and read PDFs.\n3. Build evidence matrices.\n4. Lock experiments and paper story.\n",
    "docs/proposal/paper_story.md": input.agentStrategy ? `# Paper Story\n\n${input.agentStrategy.paper_story}\n` : "# Paper Story\n\nPaper story is blocked until related work, novelty, and experiment evidence are verified.\n",
    "docs/diagnosis/ccf_a_strict_scorecard.md": `${strictScoreMarkdown(input.score)}${input.agentScore ? `\n## Agent Review\n\n${agentScoreMarkdown(input.agentScore)}` : ""}\nStrict mode: ${input.strict ? "enabled" : "disabled"}\n`,
    ...input.templatePackage.files
  };
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
  if (!options.allowNetwork || options.provider === "offline") return null;
  return new CodexOAuthClient({
    model: options.model ?? undefined,
    reasoningEffort: options.reasoningEffort ?? undefined
  });
}

async function stagedOrFallback<T>(run: () => Promise<T> | undefined, fallback: () => T | Promise<T>, warnings: string[], label: string): Promise<T> {
  const request = run();
  if (!request) return await fallback();
  try {
    return await request;
  } catch (error) {
    warnings.push(`Staged agent ${label} fell back to deterministic implementation: ${error instanceof Error ? error.message : String(error)}`);
    return await fallback();
  }
}

async function readPaperNotesWithAgent(
  agent: StagedResearchAgent | null,
  idea: string,
  chunks: PdfChunkIndexEntry[],
  warnings: string[],
  progress?: (message: string) => void
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
      `PDF reader ${paperId}`
    );
    if (note) notes.push(note);
  }
  return notes;
}

async function templatePackageArtifacts(input: { idea: string; projectName: string; venue?: string; domain?: string; strict?: boolean }): Promise<PipelineTemplatePackage> {
  const resolveInput: TemplateResolveInput = { venue: input.venue, domain: input.domain, mode: "review" };
  const resolved = await resolveTemplateProfile(resolveInput);
  const rendered = renderPaper({
    profile: resolved.profile,
    projectName: input.projectName,
    title: titleFromIdea(input.idea),
    anonymous: resolved.profile.default_review_mode === "anonymous",
    reviewMode: resolved.profile.default_review_mode,
    bibFile: "references.bib",
    macrosFile: "macros.tex"
  });
  const files: Record<string, string> = {
    ...rendered.files,
    "docs/submission/target_venue.md": `# Target Venue\n\n${input.venue ?? resolved.profile.venue_name}\n`,
    "docs/submission/venue_template_profile.json": JSON.stringify(resolved.profile, null, 2) + "\n",
    "docs/submission/template_decision.md": templateDecisionMarkdown(resolved, resolveInput),
    "docs/submission/submission_checklist.md": `# Submission Checklist\n\n- [x] Template profile selected: ${resolved.profile.profile_id}\n- [ ] Official CFP and style files verified for target year\n- [x] Anonymous mode checked\n- [x] Static compliance checked\n`,
    "docs/submission/camera_ready_todo.md": "# Camera Ready TODO\n\nPrepare author blocks, artifact links, rights blocks, and final venue metadata after acceptance.\n"
  };
  const compliance = checkTemplateComplianceArtifacts(files, {
    profile: resolved.profile,
    anonymous: resolved.profile.default_review_mode === "anonymous",
    strict: input.strict
  });
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

${candidates.slice(0, 20).map((candidate, index) => `- ${index + 1}. ${candidate.title} (${candidate.year ?? "n.d."}) — ${candidate.confidence}`).join("\n") || "- No candidates collected yet."}
`;
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
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
