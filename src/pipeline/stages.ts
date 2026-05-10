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
  "feasibility_review",
  "better_idea_synthesis",
  "artifact_writing",
  "venue_template_packaging"
] as const;

export type ResearchStageId = (typeof researchStageIds)[number];

export type ResearchStageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

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
    artifactPaths: ["docs/idea/idea_brief.md", "docs/idea/assumptions.md"]
  },
  {
    id: "search_planning",
    index: 1,
    label: "Search planning",
    prompt: "01_search_planner.md",
    deterministic: false,
    artifactPaths: ["docs/relative_work/search_plan.json"]
  },
  {
    id: "literature_search",
    index: 2,
    label: "Literature search",
    deterministic: true,
    artifactPaths: ["docs/relative_work/candidates.json", "docs/relative_work/search_report.md"]
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
    artifactPaths: ["docs/reference/paper_notes/README.md"]
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
    artifactPaths: ["docs/diagnosis/ccf_a_strict_scorecard.md"]
  },
  {
    id: "feasibility_review",
    index: 9,
    label: "Feasibility review",
    prompt: "07_feasibility_reviewer.md",
    deterministic: false,
    artifactPaths: ["docs/diagnosis/feasibility_report.md"]
  },
  {
    id: "better_idea_synthesis",
    index: 10,
    label: "Better idea synthesis",
    prompt: "08_research_strategist.md",
    deterministic: false,
    artifactPaths: ["docs/proposal/revised_idea.md", "docs/proposal/experiment_plan.md"]
  },
  {
    id: "artifact_writing",
    index: 11,
    label: "Artifact writing",
    prompt: "09_artifact_writer.md",
    deterministic: false,
    artifactPaths: []
  },
  {
    id: "venue_template_packaging",
    index: 12,
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
      "paper/template/profile.json",
      "paper/build/compile.log",
      "paper/submission/overleaf.zip"
    ]
  }
];

export function stageDefinition(id: ResearchStageId): ResearchStageDefinition {
  const stage = researchStages.find((candidate) => candidate.id === id);
  if (!stage) throw new Error(`unknown research stage: ${id}`);
  return stage;
}
