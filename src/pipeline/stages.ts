export const researchStageIds = [
  "idea_intake",
  "search_planning",
  "literature_search",
  "candidate_triage",
  "pdf_acquisition",
  "pdf_reading",
  "related_work_analysis",
  "novelty_analysis",
  "ccf_a_strict_scoring",
  "clarification_dialogue",
  "feasibility_review",
  "better_idea_synthesis",
  "artifact_writing",
  "venue_template_packaging"
] as const;

export type ResearchStageId = (typeof researchStageIds)[number];

export type ResearchStageStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "blocked";

export type ResearchStageDefinition = {
  id: ResearchStageId;
  index: number;
  label: string;
  prompt?: string;
  prompts?: string[];
  deterministic: boolean;
  artifactPaths: string[];
};

export const researchStages: ResearchStageDefinition[] = [
  {
    id: "idea_intake",
    index: 0,
    label: "Idea intake",
    prompt: "00_intake_router.md",
    deterministic: false,
    artifactPaths: ["docs/idea/raw_idea.md", "docs/idea/idea_brief.md", "docs/idea/idea_brief.json", "docs/idea/optimized_research_direction.md", "docs/idea/assumptions.md"]
  },
  {
    id: "search_planning",
    index: 1,
    label: "Search planning",
    prompt: "01_search_planner.md",
    deterministic: false,
    artifactPaths: ["docs/relative_work/search_plan.md", "docs/relative_work/search_plan.json"]
  },
  {
    id: "literature_search",
    index: 2,
    label: "Literature search",
    deterministic: true,
    artifactPaths: ["docs/relative_work/candidates.md", "docs/relative_work/candidates.json", "docs/relative_work/search_report.md"]
  },
  {
    id: "candidate_triage",
    index: 3,
    label: "Candidate triage",
    prompt: "02_candidate_triage.md",
    deterministic: false,
    artifactPaths: ["docs/relative_work/triage_report.md"]
  },
  {
    id: "pdf_acquisition",
    index: 4,
    label: "PDF acquisition",
    deterministic: true,
    artifactPaths: ["docs/reference/pdf_manifest.json"]
  },
  {
    id: "pdf_reading",
    index: 5,
    label: "PDF reading",
    prompt: "03_pdf_paper_reader.md",
    deterministic: false,
    artifactPaths: ["docs/reference/paper_notes/README.md", "docs/reference/pdf_chunks.json"]
  },
  {
    id: "related_work_analysis",
    index: 6,
    label: "Related work analysis",
    prompt: "04_related_work_analyst.md",
    deterministic: false,
    artifactPaths: ["docs/relative_work/related_work_matrix.csv", "docs/relative_work/topic_clusters.md"]
  },
  {
    id: "novelty_analysis",
    index: 7,
    label: "Novelty analysis",
    prompt: "05_novelty_gap_analyst.md",
    deterministic: false,
    artifactPaths: ["docs/relative_work/novelty_gap_matrix.md", "docs/relative_work/collision_risk.md"]
  },
  {
    id: "ccf_a_strict_scoring",
    index: 8,
    label: "CCF-A strict scoring",
    prompt: "06_ccf_a_reviewer.md",
    deterministic: false,
    artifactPaths: [
      "docs/diagnosis/ccf_a_strict_scorecard.md",
      "docs/diagnosis/reviewer_1.md",
      "docs/diagnosis/reviewer_2.md",
      "docs/diagnosis/reviewer_3.md",
      "docs/diagnosis/rebuttal_tasks.md"
    ]
  },
  {
    id: "clarification_dialogue",
    index: 9,
    label: "Clarification dialogue",
    deterministic: true,
    artifactPaths: ["docs/diagnosis/clarification_questions.md"]
  },
  {
    id: "feasibility_review",
    index: 10,
    label: "Feasibility review",
    prompt: "07_feasibility_reviewer.md",
    deterministic: false,
    artifactPaths: ["docs/diagnosis/feasibility_report.md"]
  },
  {
    id: "better_idea_synthesis",
    index: 11,
    label: "Better idea synthesis",
    prompt: "08_research_strategist.md",
    deterministic: false,
    artifactPaths: [
      "docs/proposal/revised_idea.md",
      "docs/proposal/experiment_plan.md",
      "docs/proposal/first_4_week_plan.md",
      "docs/proposal/paper_story.md"
    ]
  },
  {
    id: "artifact_writing",
    index: 12,
    label: "Artifact writing",
    prompt: "09_artifact_writer.md",
    deterministic: false,
    artifactPaths: [
      "reports/ccf_a_readiness_report.md",
      "reports/final_ccf_a_report.md",
      "reports/novelty_matrix.md",
      "reports/related_work.md",
      "reports/evidence_ledger.md",
      "plans/12_week_execution_plan.md",
      "plans/experiment_plan.md",
      "paper/abstract.md",
      "paper/related_work.md",
      "papers/papers.bib"
    ]
  },
  {
    id: "venue_template_packaging",
    index: 13,
    label: "Venue template packaging",
    prompt: "10_venue_template_selector.md",
    prompts: ["10_venue_template_selector.md", "11_latex_template_packager.md", "12_template_compliance_reviewer.md"],
    deterministic: true,
    artifactPaths: [
      "docs/submission/target_venue.md",
      "docs/submission/venue_template_profile.json",
      "docs/submission/template_decision.md",
      "docs/submission/submission_checklist.md",
      "docs/submission/anonymity_check.md",
      "docs/submission/template_compliance_report.md",
      "docs/submission/camera_ready_todo.md",
      "paper/main.tex",
      "paper/macros.tex",
      "paper/references.bib",
      "paper/sections/00_abstract.tex",
      "paper/sections/01_introduction.tex",
      "paper/sections/02_related_work.tex",
      "paper/sections/03_method.tex",
      "paper/sections/04_experiments.tex",
      "paper/sections/05_results.tex",
      "paper/sections/06_discussion.tex",
      "paper/sections/07_limitations.tex",
      "paper/sections/08_conclusion.tex",
      "paper/appendix/appendix.tex",
      "paper/checklist/reproducibility_checklist.tex",
      "paper/template/profile.json",
      "paper/template/render_config.json",
      "paper/template/README.md",
      "paper/build/compile.log",
      "paper/submission/overleaf.zip",
      "paper/submission/submission.zip"
    ]
  }
];

export function stageDefinition(id: ResearchStageId): ResearchStageDefinition {
  const stage = researchStages.find((candidate) => candidate.id === id);
  if (!stage) throw new Error(`unknown research stage: ${id}`);
  return stage;
}
