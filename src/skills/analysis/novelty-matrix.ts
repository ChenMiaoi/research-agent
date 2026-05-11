import type { PaperCandidate } from "../literature/types.js";
import type { PdfChunkIndexEntry } from "../pdf/chunk.js";
import { trustedEvidenceRows, type ClaimEvidenceRow } from "./evidence-extract.js";

export type NoveltyDimensionName = "problem" | "method" | "data" | "metric" | "evaluation" | "contribution";
export type NoveltyDimensionStatus = "strong" | "medium" | "weak" | "missing" | "blocked";
export type NoveltyDimensionRisk = "high" | "medium" | "low" | "unknown";

export type NoveltyDimensionDelta = {
  dimension: NoveltyDimensionName;
  status: NoveltyDimensionStatus;
  risk: NoveltyDimensionRisk;
  idea_signal: string;
  prior_work_overlap: string;
  idea_delta: string;
  evidence_refs: Array<{ paper_id: string; page: string; quote: string; chunk_id: string }>;
  missing_evidence: string[];
  recommended_actions: string[];
};

export type NoveltyAssessment = {
  collision_risk: "high" | "medium" | "low";
  novelty_cap?: number;
  total_cap?: number;
  reasons: string[];
  defensible_gap: string;
  evidence_refs: Array<{ paper_id: string; page: string; quote: string; chunk_id: string }>;
  dimension_deltas: NoveltyDimensionDelta[];
};

export function assessNovelty(idea: string, candidates: PaperCandidate[], evidenceRows: ClaimEvidenceRow[] = [], chunks?: PdfChunkIndexEntry[]): NoveltyAssessment {
  const trustedRows = chunks ? trustedEvidenceRows(evidenceRows, chunks) : evidenceRows;
  const verifiedRows = trustedRows.filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id);
  const verifiedPaperIds = new Set(verifiedRows.map((row) => row.paper_id));
  if (!verifiedPaperIds.size) {
    return {
      collision_risk: "low",
      reasons: ["Novelty judgment is blocked because no verified PDF evidence refs are available."],
      defensible_gap: "Read PDFs and extract page/quote/chunk evidence before making novelty or collision claims.",
      evidence_refs: [],
      dimension_deltas: noveltyDimensions(idea, candidates, [])
    };
  }
  const ideaTerms = terms(idea);
  const overlaps = candidates
    .filter((candidate) => verifiedPaperIds.has(safePaperId(candidate.candidate_id)))
    .map((candidate) => {
      const paperId = safePaperId(candidate.candidate_id);
      const evidenceText = verifiedRows.filter((row) => row.paper_id === paperId).map((row) => `${row.claim} ${row.quote ?? ""}`).join(" ");
      return overlap(ideaTerms, evidenceText);
    })
    .filter((value) => value > 0.45);
  const dimensionDeltas = noveltyDimensions(idea, candidates, verifiedRows);
  const collisionDimensions = dimensionDeltas.filter((dimension) => dimension.evidence_refs.length > 0);
  const highRiskDimensions = collisionDimensions.filter((dimension) => dimension.risk === "high").length;
  const mediumRiskDimensions = collisionDimensions.filter((dimension) => dimension.risk === "medium").length;
  if (overlaps.length >= 3) {
    const refs = evidenceRefs(trustedRows);
    return {
      collision_risk: "high",
      novelty_cap: 6,
      total_cap: 55,
      reasons: ["Multiple verified evidence-backed papers overlap strongly with the idea terms."],
      defensible_gap: "Narrow the claim to a specific setting, dataset, measurement, or failure mode not covered by overlapping work.",
      evidence_refs: refs,
      dimension_deltas: dimensionDeltas
    };
  }
  if (overlaps.length > 0 || highRiskDimensions > 0 || mediumRiskDimensions >= 2) {
    const refs = evidenceRefs(trustedRows).slice(0, 3);
    return {
      collision_risk: "medium",
      reasons: ["At least one verified evidence-backed dimension overlaps with the idea terms."],
      defensible_gap: "Use the evidence refs to identify a narrower defensible gap.",
      evidence_refs: refs,
      dimension_deltas: dimensionDeltas
    };
  }
  return {
    collision_risk: "low",
    reasons: ["No strong lexical overlap was detected in current candidates."],
    defensible_gap: "Keep novelty provisional until more verified related work is read.",
    evidence_refs: evidenceRefs(trustedRows).slice(0, 3),
    dimension_deltas: dimensionDeltas
  };
}

export function noveltyMatrixMarkdown(assessment: NoveltyAssessment): string {
  return `# Novelty Gap Matrix

- Collision risk: ${assessment.collision_risk}
- Novelty cap: ${assessment.novelty_cap ?? "none"}
- Total cap: ${assessment.total_cap ?? "none"}
- Defensible gap: ${assessment.defensible_gap}

## Dimension Delta Matrix

| Dimension | Status | Risk | Idea signal | Prior-work overlap | Delta / action |
| --- | --- | --- | --- | --- | --- |
${assessment.dimension_deltas.map((delta) => `| ${label(delta.dimension)} | ${delta.status} | ${delta.risk} | ${escapeCell(delta.idea_signal)} | ${escapeCell(delta.prior_work_overlap)} | ${escapeCell(delta.idea_delta)} |`).join("\n")}

## Reasons

${assessment.reasons.map((reason) => `- ${reason}`).join("\n")}

## Dimension Evidence

${assessment.dimension_deltas.map((delta) => `### ${label(delta.dimension)}

- Missing evidence: ${delta.missing_evidence.join("; ") || "none"}
- Recommended actions: ${delta.recommended_actions.join("; ") || "none"}
${delta.evidence_refs.map((ref) => `- Evidence: ${ref.paper_id}, page ${ref.page}, chunk ${ref.chunk_id}, quote "${ref.quote.replace(/"/g, "'").slice(0, 180)}"`).join("\n") || "- Evidence: none"}`).join("\n\n")}

## Evidence Refs

${assessment.evidence_refs.map((ref) => `- ${ref.paper_id}: page ${ref.page}, chunk ${ref.chunk_id}, quote "${ref.quote.replace(/"/g, "'").slice(0, 180)}"`).join("\n") || "- none"}
`;
}

function noveltyDimensions(idea: string, candidates: PaperCandidate[], evidenceRows: ClaimEvidenceRow[]): NoveltyDimensionDelta[] {
  const candidateByPaper = new Map(candidates.map((candidate) => [safePaperId(candidate.candidate_id), candidate]));
  return dimensionDefinitions().map((definition) => {
    const ideaSignals = matchingTerms(idea, definition.ideaTerms);
    const evidence = evidenceRows
      .filter((row) => dimensionEvidenceMatches(row, definition))
      .map((row) => ({
        row,
        candidate: candidateByPaper.get(row.paper_id),
        score: overlap(terms(idea), `${row.claim} ${row.quote ?? ""}`)
      }))
      .sort((left, right) => right.score - left.score);
    const evidenceRefs = evidence.map(({ row }) => ({
      paper_id: row.paper_id,
      page: row.page!,
      quote: row.quote!,
      chunk_id: row.chunk_id!
    }));
    const strongest = evidence[0];
    const status = dimensionStatus(Boolean(ideaSignals.length), evidence.length, strongest?.score ?? 0, evidenceRows.length);
    return {
      dimension: definition.name,
      status,
      risk: dimensionRisk(status, strongest?.score ?? 0),
      idea_signal: ideaSignals.join(", ") || "missing in idea",
      prior_work_overlap: strongest
        ? `${strongest.candidate?.title ?? strongest.row.paper_id}: ${strongest.row.quote?.slice(0, 120) ?? strongest.row.claim}`
        : evidenceRows.length ? "No verified prior-work evidence matched this dimension." : "Blocked: no verified prior-work evidence.",
      idea_delta: ideaDelta(definition.name, status),
      evidence_refs: evidenceRefs.slice(0, 3),
      missing_evidence: missingEvidence(definition.name, status, Boolean(ideaSignals.length), evidenceRefs.length),
      recommended_actions: recommendedActions(definition.name, status)
    };
  });
}

type DimensionDefinition = {
  name: NoveltyDimensionName;
  ideaTerms: string[];
  evidenceTerms: string[];
};

function dimensionDefinitions(): DimensionDefinition[] {
  return [
    { name: "problem", ideaTerms: ["problem", "task", "challenge", "objective", "question", "setting"], evidenceTerms: ["problem", "task", "challenge", "objective", "question", "setting"] },
    { name: "method", ideaTerms: ["method", "approach", "algorithm", "model", "agent", "planning", "retrieval", "intervention", "framework", "system"], evidenceTerms: ["method", "approach", "algorithm", "model", "agent", "planning", "retrieval", "intervention", "framework", "system"] },
    { name: "data", ideaTerms: ["data", "dataset", "benchmark", "corpus", "workload"], evidenceTerms: ["data", "dataset", "benchmark", "corpus", "workload"] },
    { name: "metric", ideaTerms: ["metric", "accuracy", "latency", "throughput", "recall", "precision", "f1", "score"], evidenceTerms: ["metric", "accuracy", "latency", "throughput", "recall", "precision", "f1", "score"] },
    { name: "evaluation", ideaTerms: ["evaluation", "experiment", "ablation", "baseline", "comparison", "result", "study"], evidenceTerms: ["evaluation", "experiment", "ablation", "baseline", "comparison", "result", "study"] },
    { name: "contribution", ideaTerms: ["contribution", "novel", "gap", "finding", "claim", "improve"], evidenceTerms: ["contribution", "novel", "gap", "finding", "improve"] }
  ];
}

function dimensionEvidenceMatches(row: ClaimEvidenceRow, definition: DimensionDefinition): boolean {
  const text = `${row.claim} ${row.quote ?? ""} ${row.claim_type} ${row.section ?? ""}`.toLowerCase();
  if (definition.name === "method" && row.claim_type === "method") return true;
  if (definition.name === "data" && row.claim_type === "dataset") return true;
  if (definition.name === "metric" && row.claim_type === "metric") return true;
  if (definition.name === "evaluation" && (row.claim_type === "baseline" || row.claim_type === "result")) return true;
  if (definition.name === "contribution" && row.claim_type === "result") return true;
  return definition.evidenceTerms.some((term) => text.includes(term));
}

function matchingTerms(text: string, signals: string[]): string[] {
  const lowered = text.toLowerCase();
  return signals.filter((signal) => lowered.includes(signal));
}

function dimensionStatus(hasIdeaSignal: boolean, evidenceCount: number, score: number, totalEvidenceRows: number): NoveltyDimensionStatus {
  if (!totalEvidenceRows) return "blocked";
  if (!hasIdeaSignal) return "missing";
  if (!evidenceCount) return "missing";
  if (evidenceCount >= 3 || score > 0.45) return "weak";
  if (evidenceCount > 0 || score > 0.2) return "medium";
  return "missing";
}

function dimensionRisk(status: NoveltyDimensionStatus, score: number): NoveltyDimensionRisk {
  if (status === "blocked") return "unknown";
  if (status === "missing") return "unknown";
  if (status === "weak" || score > 0.45) return "high";
  if (status === "medium") return "medium";
  return "low";
}

function ideaDelta(dimension: NoveltyDimensionName, status: NoveltyDimensionStatus): string {
  if (status === "blocked") return "No defensible delta until verified page/quote/chunk evidence exists.";
  if (status === "missing") return `Specify the ${label(dimension).toLowerCase()} claim before novelty can be defended.`;
  if (status === "weak") return `Current ${label(dimension).toLowerCase()} appears covered by verified prior work; narrow the claim.`;
  if (status === "medium") return `Potential ${label(dimension).toLowerCase()} delta exists, but needs sharper contrast and more evidence.`;
  return `No direct verified prior-work overlap found for this ${label(dimension).toLowerCase()} signal yet; keep provisional.`;
}

function missingEvidence(dimension: NoveltyDimensionName, status: NoveltyDimensionStatus, hasIdeaSignal: boolean, refs: number): string[] {
  const missing: string[] = [];
  if (!hasIdeaSignal) missing.push(`Explicit ${label(dimension).toLowerCase()} statement in the idea`);
  if (!refs) missing.push(`Verified prior-work evidence for ${label(dimension).toLowerCase()}`);
  if (status === "weak" || status === "medium") missing.push("Side-by-side contrast against closest prior work");
  return missing;
}

function recommendedActions(dimension: NoveltyDimensionName, status: NoveltyDimensionStatus): string[] {
  if (status === "blocked") return ["Read PDFs and extract page-level evidence before making novelty claims."];
  if (status === "missing") return [`Define the ${label(dimension).toLowerCase()} and add evidence requirements to the experiment plan.`];
  if (status === "weak") return [`Find a narrower ${label(dimension).toLowerCase()} gap or change the claim.`];
  if (status === "medium") return [`Add one paragraph contrasting the idea with the closest ${label(dimension).toLowerCase()} prior work.`];
  return ["Keep the claim provisional until more CCF-A related work is verified."];
}

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((term) => term.length > 3))];
}

function overlap(ideaTerms: string[], text: string): number {
  if (!ideaTerms.length) return 0;
  const lowered = text.toLowerCase();
  return ideaTerms.filter((term) => lowered.includes(term)).length / ideaTerms.length;
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}

function evidenceRefs(rows: ClaimEvidenceRow[]): NoveltyAssessment["evidence_refs"] {
  return rows
    .filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id)
    .map((row) => ({ paper_id: row.paper_id, page: row.page!, quote: row.quote!, chunk_id: row.chunk_id! }));
}

function label(value: NoveltyDimensionName): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
