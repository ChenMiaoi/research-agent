export type StrictScoreInput = {
  verifiedRelatedWorkCount?: number;
  pdfReadCount?: number;
  corePaperCount?: number;
  hasStrongBaseline?: boolean;
  hasDatasetOrBenchmark?: boolean;
  hasMetric?: boolean;
  highPriorWorkCollision?: boolean;
  pureEngineeringIntegration?: boolean;
  hasScientificHypothesis?: boolean;
  hasExecutableExperimentPlan?: boolean;
  singlePersonTwelveWeekInfeasible?: boolean;
  venueRequiresThreatModel?: boolean;
  hasThreatModel?: boolean;
  venueRequiresSystemEvaluation?: boolean;
  hasPrototype?: boolean;
  venueExpectsStrongMlBaselines?: boolean;
  hasStrongMlBaselines?: boolean;
};

export type StrictScoreResult = {
  total: number;
  uncapped_total: number;
  dimensions: Record<string, number>;
  caps: Array<{ reason: string; cap: number }>;
};

export function strictCcfAScore(input: StrictScoreInput): StrictScoreResult {
  const dimensions = {
    problem_importance: 7,
    novelty_after_related_work: input.highPriorWorkCollision ? 6 : input.verifiedRelatedWorkCount ? 12 : 8,
    technical_depth: input.pureEngineeringIntegration ? 6 : 10,
    experimental_design: input.hasExecutableExperimentPlan ? 10 : 6,
    baseline_dataset_metric: [input.hasStrongBaseline, input.hasDatasetOrBenchmark, input.hasMetric].filter(Boolean).length * 3,
    venue_fit: 7,
    feasibility: input.singlePersonTwelveWeekInfeasible ? 5 : 8,
    reproducibility_open_source_value: 4,
    paper_story: 4
  };
  const caps: StrictScoreResult["caps"] = [];
  addCap(caps, !input.verifiedRelatedWorkCount, "No verified related work", 50);
  addCap(caps, !input.pdfReadCount, "No PDF read", 45);
  addCap(caps, (input.corePaperCount ?? 0) < 5, "Fewer than 5 core related papers", 60);
  addCap(caps, !input.hasStrongBaseline, "No strong baseline", 65);
  addCap(caps, !input.hasDatasetOrBenchmark, "No dataset/benchmark", 60);
  addCap(caps, !input.hasMetric, "No metric", 60);
  addCap(caps, Boolean(input.highPriorWorkCollision), "High prior-work collision", 55);
  addCap(caps, Boolean(input.pureEngineeringIntegration && !input.hasScientificHypothesis), "Pure engineering integration without scientific hypothesis", 55);
  addCap(caps, !input.hasExecutableExperimentPlan, "No executable experiment plan", 65);
  addCap(caps, Boolean(input.singlePersonTwelveWeekInfeasible), "Single-person/12-week plan is clearly infeasible", 70);
  addCap(caps, Boolean(input.venueRequiresThreatModel && !input.hasThreatModel), "Target venue requires threat model but none exists", 65);
  addCap(caps, Boolean(input.venueRequiresSystemEvaluation && !input.hasPrototype), "Target venue requires system evaluation but prototype absent", 60);
  addCap(caps, Boolean(input.venueExpectsStrongMlBaselines && !input.hasStrongMlBaselines), "Target venue expects strong ML baselines but none defined", 65);
  const uncapped = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  const cap = caps.length ? Math.min(...caps.map((item) => item.cap)) : 100;
  return { total: Math.min(uncapped, cap), uncapped_total: uncapped, dimensions, caps };
}

export function strictScoreMarkdown(result: StrictScoreResult): string {
  return `# CCF-A Strict Scorecard\n\n- Final score: ${result.total} / 100\n- Uncapped score: ${result.uncapped_total} / 100\n- Active cap: ${result.caps.length ? Math.min(...result.caps.map((cap) => cap.cap)) : "none"}\n\n## Dimensions\n\n${Object.entries(result.dimensions).map(([name, score]) => `- ${name}: ${score}`).join("\n")}\n\n## Cap Rules\n\n${result.caps.map((cap) => `- ${cap.reason}: total cap ${cap.cap}`).join("\n") || "- none"}\n`;
}

function addCap(caps: StrictScoreResult["caps"], active: boolean, reason: string, cap: number): void {
  if (active) caps.push({ reason, cap });
}
