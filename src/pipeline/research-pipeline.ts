import type { IdeaBrief, SearchPlan } from "../agents/schemas.js";
import { paperCandidateToRecord, type PaperRecord } from "../literature.js";
import { diagnoseIdea } from "../scoring.js";
import { evidenceRowsCsv, evidenceRowsMarkdown, evidenceText, extractEvidenceRows } from "../skills/analysis/evidence-extract.js";
import { strictCcfAScore, strictScoreMarkdown } from "../skills/analysis/ccf-a-score.js";
import { experimentPlanMarkdown, feasibilityMarkdown, revisedIdeaMarkdown } from "../skills/analysis/idea-refine.js";
import { assessNovelty, noveltyMatrixMarkdown } from "../skills/analysis/novelty-matrix.js";
import { relatedWorkMatrixCsv, topicClustersMarkdown } from "../skills/analysis/related-work-matrix.js";
import { searchLiteratureAsync } from "../literature.js";
import type { LiteratureSource, PaperCandidate } from "../skills/literature/types.js";
import { acquirePdfs } from "../skills/pdf/acquire.js";
import { buildPdfChunkIndex } from "../skills/pdf/chunk.js";
import type { PdfManifestRecord } from "../skills/pdf/provenance.js";
import { createResearchPipelineState, markStage, type ResearchPipelineState } from "./stage-state.js";
import { researchStages } from "./stages.js";

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
  let state = createResearchPipelineState(idea);
  for (const stage of researchStages) {
    state = markStage(state, stage.id, "running");
    options.progress?.(`Research pipeline: ${stage.label}`);
    state = markStage(state, stage.id, stage.deterministic || options.provider === "offline" || !options.allowNetwork ? "completed" : "skipped");
  }

  const diagnosis = diagnoseIdea(idea, { requestedDomains: options.requestedDomains });
  const route = diagnosis.routes[0]!;
  const terms = seedTerms(idea);
  const venues = options.venue ? [options.venue] : route.domain.primary_venues.slice(0, 4);
  const ideaBrief: IdeaBrief = {
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
  const searchPlan = offlineSearchPlan(ideaBrief, options.maxPapers ?? 20);
  const queries = searchPlanQueries(searchPlan);
  const literature = await searchLiteratureAsync({
    queries,
    allowNetwork: Boolean(options.allowNetwork),
    limit: options.maxPapers ?? 20,
    idea,
    sources: options.sources as LiteratureSource[] | undefined
  });
  const candidates = literature.candidates;
  const outputRoot = options.outputRoot ?? process.cwd();
  const manifest = await acquirePdfs(candidates, {
    outputRoot,
    allowNetwork: Boolean(options.allowNetwork),
    downloadPdfs: Boolean(options.downloadPdfs)
  });
  const chunks = await buildPdfChunkIndex(outputRoot, manifest);
  const evidenceRows = extractEvidenceRows(chunks);
  const noteArtifacts = evidenceRowsMarkdown(evidenceRows);
  const novelty = assessNovelty(idea, candidates, evidenceRows);
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
  const artifacts = pipelineArtifacts({
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
    searchReport: literature.search_report,
    baselineRecommendations,
    datasetRecommendations,
    metricRecommendations,
    claimEvidenceRows,
    strict: Boolean(options.strictCcfA)
  });
  return {
    state,
    ideaBrief,
    searchPlan,
    verifiedPapers: verifiedPaperRecords(candidates, manifest, evidenceRows),
    baselineRecommendations,
    datasetRecommendations,
    metricRecommendations,
    claimEvidenceRows,
    artifacts,
    warnings: [...literature.warnings, ...(options.allowNetwork ? [] : ["Network disabled; literature candidates require a later search stage."])]
  };
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
}): Record<string, string> {
  return {
    "docs/idea/idea_brief.md": `# Idea Brief\n\n${JSON.stringify(input.ideaBrief, null, 2)}\n`,
    "docs/idea/assumptions.md": `# Assumptions\n\n${input.ideaBrief.assumptions.map((item) => `- ${item}`).join("\n")}\n`,
    "docs/relative_work/search_plan.json": JSON.stringify(input.searchPlan, null, 2) + "\n",
    "docs/relative_work/search_report.md": input.searchReport,
    "docs/relative_work/candidates.json": JSON.stringify(input.candidates, null, 2) + "\n",
    "docs/relative_work/triage_report.md": triageReport(input.candidates),
    "docs/reference/pdf_manifest.json": JSON.stringify(input.manifest, null, 2) + "\n",
    "docs/reference/paper_notes/README.md": "# Paper Notes\n\nNo PDFs have been read yet. Every future note must cite page, quote, and chunk id.\n",
    ...input.noteArtifacts,
    "docs/relative_work/related_work_matrix.csv": relatedWorkMatrixCsv(input.candidates, input.manifest, input.evidenceRows),
    "docs/reference/claim_evidence_matrix.csv": evidenceRowsCsv(input.evidenceRows),
    "docs/relative_work/topic_clusters.md": topicClustersMarkdown(input.candidates),
    "docs/relative_work/novelty_gap_matrix.md": noveltyMatrixMarkdown(input.novelty),
    "docs/relative_work/collision_risk.md": `# Collision Risk\n\n${input.novelty.collision_risk}\n\n${input.novelty.reasons.map((reason) => `- ${reason}`).join("\n")}\n`,
    "docs/relative_work/baseline_recommendations.md": `# Baseline Recommendations\n\n${input.baselineRecommendations.length ? input.baselineRecommendations.map((item) => `- ${item}`).join("\n") : "- Blocked until verified PDF evidence identifies reviewer-expected baselines."}\n`,
    "docs/reference/pdf_chunks.json": JSON.stringify(input.chunks, null, 2) + "\n",
    "docs/diagnosis/feasibility_report.md": feasibilityMarkdown(input.ideaBrief.resource_constraints, 12),
    "docs/diagnosis/reviewer_panel.md": "# Reviewer Panel\n\nReviewer panel simulation requires verified evidence before final judgment.\n",
    "docs/proposal/experiment_plan.md": `${experimentPlanMarkdown()}\n## Evidence Status\n\n- Baselines evidence-backed: ${input.baselineRecommendations.length ? "yes" : "no"}\n- Datasets evidence-backed: ${input.datasetRecommendations.length ? "yes" : "no"}\n- Metrics evidence-backed: ${input.metricRecommendations.length ? "yes" : "no"}\n`,
    "docs/proposal/revised_idea.md": revisedIdeaMarkdown(input.idea, input.novelty, input.score),
    "docs/proposal/first_4_week_plan.md": "# First 4 Week Plan\n\n1. Plan search and triage candidates.\n2. Acquire and read PDFs.\n3. Build evidence matrices.\n4. Lock experiments and paper story.\n",
    "docs/proposal/paper_story.md": "# Paper Story\n\nPaper story is blocked until related work, novelty, and experiment evidence are verified.\n",
    "docs/diagnosis/ccf_a_strict_scorecard.md": `${strictScoreMarkdown(input.score)}\nStrict mode: ${input.strict ? "enabled" : "disabled"}\n`,
    "docs/submission/target_venue.md": "# Target Venue\n\nTarget venue is unresolved until template selection runs.\n",
    "docs/submission/venue_template_profile.json": "{}\n",
    "docs/submission/template_decision.md": "# Template Decision\n\nNo venue template has been selected yet.\n",
    "docs/submission/submission_checklist.md": "# Submission Checklist\n\n- [ ] Template profile selected\n- [ ] Anonymous mode checked\n- [ ] Compliance checked\n",
    "docs/submission/anonymity_check.md": "# Anonymity Check\n\nNot checked yet.\n",
    "docs/submission/template_compliance_report.md": "# Template Compliance Report\n\nStatic checks have not run yet.\n",
    "docs/submission/camera_ready_todo.md": "# Camera Ready TODO\n\nPrepare after acceptance and final venue instructions.\n",
    "paper/main.tex": "\\documentclass{article}\n\\input{macros}\n\\title{Evidence-First Research Draft}\n\\begin{document}\n\\maketitle\n\\input{sections/00_abstract}\n\\input{sections/01_introduction}\n\\input{sections/02_related_work}\n\\input{sections/03_method}\n\\input{sections/04_experiments}\n\\input{sections/05_results}\n\\input{sections/06_discussion}\n\\input{sections/07_limitations}\n\\input{sections/08_conclusion}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n",
    "paper/macros.tex": "% Shared macros for venue-aware rendering.\n",
    "paper/references.bib": "% Add verified BibTeX entries only.\n",
    "paper/sections/00_abstract.tex": "% Abstract placeholder.\n",
    "paper/sections/01_introduction.tex": "% Introduction placeholder.\n",
    "paper/sections/02_related_work.tex": "% Related work placeholder.\n",
    "paper/sections/03_method.tex": "% Method placeholder.\n",
    "paper/sections/04_experiments.tex": "% Experiments placeholder.\n",
    "paper/sections/05_results.tex": "% Results placeholder.\n",
    "paper/sections/06_discussion.tex": "% Discussion placeholder.\n",
    "paper/sections/07_limitations.tex": "% Limitations placeholder.\n",
    "paper/sections/08_conclusion.tex": "% Conclusion placeholder.\n",
    "paper/appendix/appendix.tex": "% Appendix placeholder.\n",
    "paper/checklist/reproducibility_checklist.tex": "% Reproducibility checklist placeholder.\n",
    "paper/template/profile.json": "{}\n",
    "paper/template/README.md": "# Paper Template\n\nRendered template metadata lives here.\n",
    "paper/build/compile.log": "Compile not run.\n",
    "paper/submission/overleaf.zip": ""
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
