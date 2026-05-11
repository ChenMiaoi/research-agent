import type { StrictScoreResult } from "./ccf-a-score.js";
import type { NoveltyAssessment } from "./novelty-matrix.js";

export function revisedIdeaMarkdown(idea: string, novelty: NoveltyAssessment, score: StrictScoreResult): string {
  return `# Revised Idea\n\n## Starting Point\n\n${idea}\n\n## Revised Direction\n\nFocus the project on a narrow, testable claim that survives the current collision risk: ${novelty.defensible_gap}\n\n## Central Hypothesis\n\nA measurable method or benchmark change will improve a reviewer-relevant metric over verified baselines under a documented resource constraint.\n\n## Score Constraints To Resolve\n\n${score.caps.map((cap) => `- ${cap.reason}`).join("\n") || "- No active caps."}\n`;
}

export function experimentPlanMarkdown(): string {
  return `# Experiment Plan\n\n- Baselines: choose at least one strong recent baseline after PDF triage.\n- Datasets: use a public benchmark or owned dataset with documented access.\n- Metrics: define one primary metric and secondary robustness/failure metrics.\n- Ablations: remove each claimed method component.\n- Failure cases: collect negative examples and boundary conditions.\n- Reproducibility: log seeds, commands, versions, and hardware.\n`;
}

export function feasibilityMarkdown(resources: string[] = [], timelineWeeks = 12): string {
  const singlePerson = resources.some((resource) => /single|solo|one/i.test(resource));
  return `# Feasibility Report\n\n- Timeline: ${timelineWeeks} weeks\n- Resources: ${resources.join(", ") || "unspecified"}\n- MVP: literature verification, one baseline, one dataset, one metric, one ablation.\n- Ambitious extension: broader benchmark suite and additional venues.\n- Risk: ${singlePerson && timelineWeeks <= 12 ? "single-person 12-week scope must stay narrow" : "scope must be checked against available compute and data"}.\n`;
}
