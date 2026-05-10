import type { IdeaBrief, SearchPlan } from "../agents/schemas.js";
import type { PaperRecord } from "../literature.js";
import { diagnoseIdea } from "../scoring.js";
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
  const baselineRecommendations = ["Identify strongest recent baseline after candidate triage."];
  const datasetRecommendations = ["Select public benchmark or owned dataset before scoring experimental soundness."];
  const metricRecommendations = ["Define primary metric, secondary metrics, and failure-case criteria."];
  const claimEvidenceRows = [
    {
      claim: "Main contribution improves over verified baselines.",
      required_evidence: "At least one result table linked to verified baseline, dataset, and metric.",
      planned_artifact: "results/tables/main_results.csv",
      status: "planned"
    }
  ];
  const artifacts = pipelineArtifacts({
    ideaBrief,
    searchPlan,
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
    verifiedPapers: [],
    baselineRecommendations,
    datasetRecommendations,
    metricRecommendations,
    claimEvidenceRows,
    artifacts,
    warnings: options.allowNetwork ? [] : ["Network disabled; literature candidates require a later search stage."]
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
  ideaBrief: IdeaBrief;
  searchPlan: SearchPlan;
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
    "docs/relative_work/search_report.md": "# Search Report\n\nOffline search plan created. Run literature search with network enabled to collect candidates.\n",
    "docs/relative_work/candidates.json": "[]\n",
    "docs/relative_work/triage_report.md": "# Candidate Triage\n\nNo candidates have been triaged yet.\n",
    "docs/reference/pdf_manifest.json": "[]\n",
    "docs/reference/paper_notes/README.md": "# Paper Notes\n\nNo PDFs have been read yet. Every future note must cite page, quote, and chunk id.\n",
    "docs/relative_work/related_work_matrix.csv": "paper_id,title,claim,evidence_ref,collision_risk\nTODO,Add verified papers before making claims,TODO,TODO,unknown\n",
    "docs/relative_work/topic_clusters.md": "# Topic Clusters\n\nNo verified paper notes are available yet.\n",
    "docs/relative_work/novelty_gap_matrix.md": "# Novelty Gap Matrix\n\nNovelty cannot be judged until verified related work is read.\n",
    "docs/relative_work/collision_risk.md": "# Collision Risk\n\nUnknown until candidate triage and PDF reading complete.\n",
    "docs/relative_work/baseline_recommendations.md": `# Baseline Recommendations\n\n${input.baselineRecommendations.map((item) => `- ${item}`).join("\n")}\n`,
    "docs/diagnosis/feasibility_report.md": "# Feasibility Report\n\nFeasibility must model timeline, compute, data access, implementation risk, evaluation risk, and writing risk.\n",
    "docs/proposal/experiment_plan.md": `# Experiment Plan\n\n- Datasets: ${input.datasetRecommendations.join("; ")}\n- Metrics: ${input.metricRecommendations.join("; ")}\n- Evidence rows: ${input.claimEvidenceRows.length}\n`,
    "docs/proposal/revised_idea.md": "# Revised Idea\n\nA revised idea can only be finalized after related-work, novelty, strict score, and feasibility stages complete.\n",
    "docs/diagnosis/ccf_a_strict_scorecard.md": `# CCF-A Strict Scorecard\n\nStrict mode: ${input.strict ? "enabled" : "disabled"}\n\nNo verified PDF evidence is present, so strict evidence caps must apply.\n`,
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
