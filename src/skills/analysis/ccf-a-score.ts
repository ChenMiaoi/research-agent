export type StrictScoreInput = {
  verifiedRelatedWorkCount?: number;
  pdfReadCount?: number;
  corePaperCount?: number;
  ccfAGateBlocked?: boolean;
  evidenceRefs?: string[];
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

export type StrictScoreType = "Preliminary" | "Evidence-backed" | "Submission-ready";

export type ScoreDimension = {
  name: string;
  score: number;
  maxScore: number;
  confidence: number;
  rationale: string;
  positiveEvidence: string[];
  negativeEvidence: string[];
  missingEvidence: string[];
  recommendedActions: string[];
};

export type StrictScoreResult = {
  total: number;
  uncapped_total: number;
  score_type: StrictScoreType;
  dimensions: Record<string, number>;
  score_dimensions: ScoreDimension[];
  confidence: number;
  caps: Array<{ reason: string; cap: number }>;
  hard_blockers: string[];
  soft_weaknesses: string[];
  why_not_ccf_a: string[];
  path_to_70: string[];
  path_to_80: string[];
};

const RUBRIC = [
  { key: "problem_significance", name: "Problem Significance", maxScore: 10 },
  { key: "novelty", name: "Novelty", maxScore: 20 },
  { key: "technical_depth", name: "Technical Depth", maxScore: 15 },
  { key: "method_clarity", name: "Method Clarity", maxScore: 10 },
  { key: "experimental_rigor", name: "Experimental Rigor", maxScore: 20 },
  { key: "related_work", name: "Related Work", maxScore: 10 },
  { key: "feasibility_reproducibility", name: "Feasibility / Reproducibility", maxScore: 10 },
  { key: "venue_story", name: "Venue / Story", maxScore: 5 }
] as const;

export function strictCcfAScore(input: StrictScoreInput): StrictScoreResult {
  const scoreDimensions = strictRubricDimensions(input);
  const dimensions = Object.fromEntries(scoreDimensions.map((dimension, index) => [RUBRIC[index]!.key, dimension.score]));
  const caps: StrictScoreResult["caps"] = [];
  addCap(caps, !input.verifiedRelatedWorkCount, "No verified related work", 45);
  addCap(caps, Boolean(input.ccfAGateBlocked), "CCF-A venue gate blocked", 55);
  addCap(caps, (input.corePaperCount ?? 0) <= 0, "No CCF-A core papers", 55);
  addCap(caps, !input.hasStrongBaseline || !input.hasDatasetOrBenchmark || !input.hasMetric, "No baseline/dataset/metric", 60);
  addCap(caps, Boolean(input.pureEngineeringIntegration && !input.hasScientificHypothesis), "Engineering artifact without research question", 50);
  addCap(caps, Boolean(input.highPriorWorkCollision), "High prior-work collision", 40);
  addCap(caps, !input.hasExecutableExperimentPlan, "No executable experiment plan", 65);
  addCap(caps, !input.pdfReadCount, "No PDF read", 45);
  addCap(caps, Boolean(input.singlePersonTwelveWeekInfeasible), "Single-person/12-week plan is clearly infeasible", 70);
  addCap(caps, Boolean(input.venueRequiresThreatModel && !input.hasThreatModel), "Target venue requires threat model but none exists", 65);
  addCap(caps, Boolean(input.venueRequiresSystemEvaluation && !input.hasPrototype), "Target venue requires system evaluation but prototype absent", 60);
  addCap(caps, Boolean(input.venueExpectsStrongMlBaselines && !input.hasStrongMlBaselines), "Target venue expects strong ML baselines but none defined", 65);
  const uncapped = scoreDimensions.reduce((sum, dimension) => sum + dimension.score, 0);
  const cap = caps.length ? Math.min(...caps.map((item) => item.cap)) : 100;
  const total = Math.min(uncapped, cap);
  const scoreType = strictScoreType(input, caps, total);
  const hardBlockers = caps.map((item) => item.reason);
  const softWeaknesses = scoreDimensions
    .filter((dimension) => dimension.score / dimension.maxScore < 0.7)
    .flatMap((dimension) => dimension.missingEvidence)
    .filter((item) => !hardBlockers.includes(item));
  return {
    total,
    uncapped_total: uncapped,
    score_type: scoreType,
    dimensions,
    score_dimensions: scoreDimensions,
    confidence: scoreConfidence(input, scoreDimensions),
    caps,
    hard_blockers: hardBlockers,
    soft_weaknesses: [...new Set(softWeaknesses)],
    why_not_ccf_a: whyNotCcfA(scoreType, caps, scoreDimensions),
    path_to_70: targetScorePath(70, caps, scoreDimensions),
    path_to_80: targetScorePath(80, caps, scoreDimensions)
  };
}

export function strictScoreMarkdown(result: StrictScoreResult): string {
  const activeCap = result.caps.length ? Math.min(...result.caps.map((cap) => cap.cap)) : "none";
  return `# CCF-A Strict Scorecard

- Final score: ${result.total} / 100
- Uncapped score: ${result.uncapped_total} / 100
- Score type: ${result.score_type}
- Confidence: ${result.confidence}
- Active cap: ${activeCap}

## Active Caps

| Reason | Cap |
| --- | ---: |
${result.caps.map((cap) => `| ${escapeCell(cap.reason)} | ${cap.cap} |`).join("\n") || "| none | none |"}

## Strict Rubric

| Dimension | Score | Confidence | Evidence | Missing | Rationale |
| --- | ---: | ---: | --- | --- | --- |
${result.score_dimensions.map((dimension) => `| ${dimension.name} | ${dimension.score}/${dimension.maxScore} | ${dimension.confidence} | ${escapeCell(dimensionEvidenceSummary(dimension))} | ${escapeCell(dimension.missingEvidence.join("; ") || "none")} | ${escapeCell(dimension.rationale)} |`).join("\n")}

## Hard Blockers

${result.hard_blockers.map((blocker, index) => `${index + 1}. ${blocker}`).join("\n") || "- none"}

## Soft Weaknesses

${result.soft_weaknesses.map((weakness) => `- ${weakness}`).join("\n") || "- none"}

## Missing Evidence By Dimension

${result.score_dimensions.map((dimension) => `### ${dimension.name}

- Positive evidence: ${dimension.positiveEvidence.join("; ") || "none"}
- Negative evidence: ${dimension.negativeEvidence.join("; ") || "none"}
- Missing evidence: ${dimension.missingEvidence.join("; ") || "none"}
- Recommended actions: ${dimension.recommendedActions.join("; ") || "none"}`).join("\n\n")}

## Why not CCF-A

${result.why_not_ccf_a.map((reason, index) => `${index + 1}. ${reason}`).join("\n") || "- Current deterministic evidence gates do not identify a blocking CCF-A reason."}

## Path to 70

${result.path_to_70.map((action, index) => `${index + 1}. ${action}`).join("\n") || "- Already at or above 70 under current caps."}

## Path to 80

${result.path_to_80.map((action, index) => `${index + 1}. ${action}`).join("\n") || "- Already at or above 80 under current caps."}

## Cap Rules

${result.caps.map((cap) => `- ${cap.reason}: total cap ${cap.cap}`).join("\n") || "- none"}
`;
}

function strictScoreType(input: StrictScoreInput, caps: StrictScoreResult["caps"], total: number): StrictScoreType {
  const noVerifiedPdfNotes = !input.verifiedRelatedWorkCount || !input.pdfReadCount;
  const ccfGateBlocked = Boolean(input.ccfAGateBlocked || (input.corePaperCount ?? 0) <= 0);
  if (noVerifiedPdfNotes || ccfGateBlocked) return "Preliminary";
  const enoughEvidenceForSubmission = (input.verifiedRelatedWorkCount ?? 0) >= 5 && (input.pdfReadCount ?? 0) >= 5 && (input.corePaperCount ?? 0) >= 5;
  if (!caps.length && total >= 70 && enoughEvidenceForSubmission) return "Submission-ready";
  return "Evidence-backed";
}

function whyNotCcfA(scoreType: StrictScoreType, caps: StrictScoreResult["caps"], dimensions: ScoreDimension[]): string[] {
  const capReasons = caps.map((cap) => `${cap.reason} caps the score at ${cap.cap}.`);
  const missing = dimensions
    .flatMap((dimension) => dimension.missingEvidence.map((item) => `${dimension.name}: ${item}.`))
    .slice(0, 8);
  const typeReason = scoreType === "Submission-ready" ? [] : [`Score type is ${scoreType}, so the project is not yet submission-ready under the strict rubric.`];
  return [...new Set([...typeReason, ...capReasons, ...missing])];
}

function strictRubricDimensions(input: StrictScoreInput): ScoreDimension[] {
  const evidenceRefs = input.evidenceRefs ?? [];
  const verifiedRelatedWork = input.verifiedRelatedWorkCount ?? 0;
  const pdfRead = input.pdfReadCount ?? 0;
  const corePapers = input.corePaperCount ?? 0;
  return [
    dimension({
      name: "Problem Significance",
      maxScore: 10,
      score: input.pureEngineeringIntegration && !input.hasScientificHypothesis ? 5 : evidenceRefs.length ? 8 : 6,
      confidence: evidenceRefs.length ? 0.65 : 0.45,
      positiveEvidence: evidenceRefs.slice(0, 3),
      negativeEvidence: [],
      missingEvidence: evidenceRefs.length ? [] : ["Venue-grounded evidence that the problem matters"],
      recommendedActions: ["Tie the problem to recent CCF-A papers, benchmarks, or documented failure modes."]
    }),
    dimension({
      name: "Novelty",
      maxScore: 20,
      score: input.highPriorWorkCollision ? 4 : verifiedRelatedWork >= 5 && corePapers >= 5 ? 15 : verifiedRelatedWork > 0 ? 10 : 6,
      confidence: confidenceForEvidence(verifiedRelatedWork, pdfRead, evidenceRefs.length),
      positiveEvidence: verifiedRelatedWork && !input.highPriorWorkCollision ? evidenceRefs.slice(0, 5) : [],
      negativeEvidence: input.highPriorWorkCollision ? evidenceRefs.slice(0, 3) : [],
      missingEvidence: [
        ...missingWhen(verifiedRelatedWork < 5, "Verified related-work comparisons"),
        ...missingWhen(corePapers < 5, "Enough CCF-A core papers"),
        ...missingWhen(Boolean(input.highPriorWorkCollision), "Narrow novelty delta against closest prior work")
      ],
      recommendedActions: ["State the exact idea-vs-prior-work delta with page-level evidence."]
    }),
    dimension({
      name: "Technical Depth",
      maxScore: 15,
      score: input.pureEngineeringIntegration && !input.hasScientificHypothesis ? 5 : input.hasScientificHypothesis ? 12 : 9,
      confidence: input.hasScientificHypothesis ? 0.65 : 0.45,
      positiveEvidence: input.hasScientificHypothesis ? evidenceRefs.slice(0, 2) : [],
      negativeEvidence: [],
      missingEvidence: missingWhen(!input.hasScientificHypothesis, "Testable scientific hypothesis or research question"),
      recommendedActions: ["State the mechanism, measurement, or generalization hypothesis reviewers can falsify."]
    }),
    dimension({
      name: "Method Clarity",
      maxScore: 10,
      score: input.hasScientificHypothesis ? 8 : 5,
      confidence: input.hasScientificHypothesis ? 0.6 : 0.4,
      positiveEvidence: input.hasScientificHypothesis ? evidenceRefs.slice(0, 2) : [],
      negativeEvidence: [],
      missingEvidence: missingWhen(!input.hasScientificHypothesis, "Clear method claim tied to the research question"),
      recommendedActions: ["Rewrite the method as inputs, intervention, expected behavior, and failure modes."]
    }),
    dimension({
      name: "Experimental Rigor",
      maxScore: 20,
      score: 4 + (input.hasStrongBaseline ? 4 : 0) + (input.hasDatasetOrBenchmark ? 4 : 0) + (input.hasMetric ? 4 : 0) + (input.hasExecutableExperimentPlan ? 4 : 0),
      confidence: [input.hasStrongBaseline, input.hasDatasetOrBenchmark, input.hasMetric, input.hasExecutableExperimentPlan].filter(Boolean).length / 5 + 0.2,
      positiveEvidence: evidenceRefs.slice(0, 5),
      negativeEvidence: [],
      missingEvidence: [
        ...missingWhen(!input.hasStrongBaseline, "Strong baseline"),
        ...missingWhen(!input.hasDatasetOrBenchmark, "Concrete dataset or benchmark"),
        ...missingWhen(!input.hasMetric, "Primary success metric"),
        ...missingWhen(!input.hasExecutableExperimentPlan, "Executable experiment plan")
      ],
      recommendedActions: ["Lock one baseline, one dataset, one primary metric, and a runnable protocol."]
    }),
    dimension({
      name: "Related Work",
      maxScore: 10,
      score: verifiedRelatedWork >= 5 && corePapers >= 5 && pdfRead >= 5 ? 8 : verifiedRelatedWork > 0 ? 5 : 2,
      confidence: confidenceForEvidence(verifiedRelatedWork, pdfRead, evidenceRefs.length),
      positiveEvidence: verifiedRelatedWork ? evidenceRefs.slice(0, 5) : [],
      negativeEvidence: [],
      missingEvidence: [
        ...missingWhen(verifiedRelatedWork < 5, "Five verified related-work comparisons"),
        ...missingWhen(corePapers < 5, "CCF-A core paper coverage"),
        ...missingWhen(pdfRead < 5, "PDF-read evidence for related-work claims")
      ],
      recommendedActions: ["Build a side-by-side matrix using paper, page, quote, and chunk ids."]
    }),
    dimension({
      name: "Feasibility / Reproducibility",
      maxScore: 10,
      score: 2 + (input.hasExecutableExperimentPlan ? 3 : 0) + (input.hasStrongBaseline ? 2 : 0) + (input.hasDatasetOrBenchmark ? 2 : 0) + (input.singlePersonTwelveWeekInfeasible ? 0 : 1),
      confidence: evidenceRefs.length ? 0.65 : 0.35,
      positiveEvidence: evidenceRefs.slice(0, 4),
      negativeEvidence: input.singlePersonTwelveWeekInfeasible ? ["single-person/12-week feasibility risk"] : [],
      missingEvidence: [
        ...missingWhen(!input.hasExecutableExperimentPlan, "Reproducible experiment commands or protocol"),
        ...missingWhen(!input.hasStrongBaseline, "Baseline reproduction plan"),
        ...missingWhen(Boolean(input.singlePersonTwelveWeekInfeasible), "Feasible resource and timeline scope")
      ],
      recommendedActions: ["Add commands, seeds, artifact paths, and a scoped compute plan."]
    }),
    dimension({
      name: "Venue / Story",
      maxScore: 5,
      score: venueStoryScore(input),
      confidence: input.venueRequiresThreatModel || input.venueRequiresSystemEvaluation || input.venueExpectsStrongMlBaselines ? 0.55 : 0.45,
      positiveEvidence: [],
      negativeEvidence: [],
      missingEvidence: [
        ...missingWhen(Boolean(input.venueRequiresThreatModel && !input.hasThreatModel), "Venue-appropriate threat model"),
        ...missingWhen(Boolean(input.venueRequiresSystemEvaluation && !input.hasPrototype), "System evaluation artifact"),
        ...missingWhen(Boolean(input.venueExpectsStrongMlBaselines && !input.hasStrongMlBaselines), "Venue-expected ML baselines")
      ],
      recommendedActions: ["Align the paper story with the target venue's evidence expectations."]
    })
  ];
}

function venueStoryScore(input: StrictScoreInput): number {
  let score = 4;
  if (input.venueRequiresThreatModel && !input.hasThreatModel) score -= 2;
  if (input.venueRequiresSystemEvaluation && !input.hasPrototype) score -= 2;
  if (input.venueExpectsStrongMlBaselines && !input.hasStrongMlBaselines) score -= 2;
  return Math.max(1, score);
}

function dimension(input: Omit<ScoreDimension, "rationale"> & { rationale?: string }): ScoreDimension {
  return {
    ...input,
    rationale: input.rationale ?? rationaleForDimension(input.name, input.score, input.maxScore),
    score: Math.max(0, Math.min(input.maxScore, Math.round(input.score))),
    confidence: clampConfidence(input.confidence),
    positiveEvidence: [...new Set(input.positiveEvidence)],
    negativeEvidence: [...new Set(input.negativeEvidence)],
    missingEvidence: [...new Set(input.missingEvidence)],
    recommendedActions: [...new Set(input.recommendedActions)]
  };
}

function addCap(caps: StrictScoreResult["caps"], active: boolean, reason: string, cap: number): void {
  if (active) caps.push({ reason, cap });
}

function rationaleForDimension(name: string, score: number, maxScore: number): string {
  const percent = maxScore ? score / maxScore : 0;
  if (percent >= 0.8) return `${name} is provisionally strong under the strict evidence-gated rubric.`;
  if (percent >= 0.55) return `${name} is plausible but still needs stronger evidence or sharper framing.`;
  return `${name} is capped by missing evidence, weak claim definition, or unresolved reviewer expectations.`;
}

function targetScorePath(target: 70 | 80, caps: StrictScoreResult["caps"], dimensions: ScoreDimension[]): string[] {
  const capActions = caps
    .filter((cap) => cap.cap < target)
    .map((cap) => actionForMissingEvidence(cap.reason));
  const dimensionActions = [...dimensions]
    .sort((left, right) => (right.maxScore - right.score) - (left.maxScore - left.score))
    .flatMap((dimension) => dimension.recommendedActions)
    .slice(0, target === 70 ? 4 : 6);
  const stretchActions = target === 80
    ? ["Add ablations, robustness checks, and failure analysis tied to the main claim.", "Ensure every positive claim has paper/page/quote/chunk provenance."]
    : [];
  return [...new Set([...capActions, ...dimensionActions, ...stretchActions])].slice(0, target === 70 ? 6 : 8);
}

function scoreConfidence(input: StrictScoreInput, dimensions: ScoreDimension[]): number {
  const evidenceConfidence = confidenceForEvidence(input.verifiedRelatedWorkCount ?? 0, input.pdfReadCount ?? 0, input.evidenceRefs?.length ?? 0);
  const dimensionConfidence = dimensions.reduce((sum, dimension) => sum + dimension.confidence, 0) / Math.max(1, dimensions.length);
  return clampConfidence((evidenceConfidence + dimensionConfidence) / 2);
}

function confidenceForEvidence(verifiedRelatedWork: number, pdfRead: number, evidenceRefs: number): number {
  return clampConfidence(0.3 + Math.min(0.25, verifiedRelatedWork * 0.04) + Math.min(0.25, pdfRead * 0.04) + Math.min(0.15, evidenceRefs * 0.02));
}

function clampConfidence(value: number): number {
  return Math.round(Math.max(0.2, Math.min(0.9, value)) * 100) / 100;
}

function missingWhen(condition: boolean, value: string): string[] {
  return condition ? [value] : [];
}

function dimensionEvidenceSummary(dimension: ScoreDimension): string {
  const positive = dimension.positiveEvidence.length ? `positive: ${dimension.positiveEvidence.join("; ")}` : "positive: none";
  const negative = dimension.negativeEvidence.length ? `negative: ${dimension.negativeEvidence.join("; ")}` : "negative: none";
  return `${positive}; ${negative}`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function actionForMissingEvidence(reason: string): string {
  if (/related work|core papers/i.test(reason)) return "Read and cite enough CCF-A core related papers with page-level evidence.";
  if (/pdf/i.test(reason)) return "Acquire public PDFs and extract page, quote, and chunk evidence.";
  if (/baseline|dataset|metric/i.test(reason)) return "Define baseline, dataset or benchmark, and primary metric together.";
  if (/collision/i.test(reason)) return "Narrow the novelty claim against the closest overlapping papers.";
  if (/research question|hypothesis|engineering/i.test(reason)) return "State a falsifiable research question beyond implementation value.";
  if (/experiment plan/i.test(reason)) return "Write an executable experiment plan tied to baselines and metrics.";
  if (/threat model/i.test(reason)) return "Write a venue-appropriate threat model.";
  if (/system evaluation|prototype/i.test(reason)) return "Build or scope a prototype with system evaluation metrics.";
  return `Resolve blocker: ${reason}.`;
}
