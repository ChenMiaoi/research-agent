import type { PaperCandidate } from "../literature/types.js";
import type { ClaimEvidenceRow } from "./evidence-extract.js";

export type NoveltyAssessment = {
  collision_risk: "high" | "medium" | "low";
  novelty_cap?: number;
  total_cap?: number;
  reasons: string[];
  defensible_gap: string;
  evidence_refs: Array<{ paper_id: string; page: string; quote: string; chunk_id: string }>;
};

export function assessNovelty(idea: string, candidates: PaperCandidate[], evidenceRows: ClaimEvidenceRow[] = []): NoveltyAssessment {
  const verifiedPaperIds = new Set(evidenceRows.filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id).map((row) => row.paper_id));
  if (!verifiedPaperIds.size) {
    return {
      collision_risk: "low",
      reasons: ["Novelty judgment is blocked because no verified PDF evidence refs are available."],
      defensible_gap: "Read PDFs and extract page/quote/chunk evidence before making novelty or collision claims.",
      evidence_refs: []
    };
  }
  const ideaTerms = terms(idea);
  const overlaps = candidates
    .filter((candidate) => verifiedPaperIds.has(safePaperId(candidate.candidate_id)))
    .map((candidate) => {
      const paperId = safePaperId(candidate.candidate_id);
      const evidenceText = evidenceRows.filter((row) => row.paper_id === paperId).map((row) => `${row.claim} ${row.quote ?? ""}`).join(" ");
      return overlap(ideaTerms, evidenceText);
    })
    .filter((value) => value > 0.45);
  if (overlaps.length >= 3) {
    const refs = evidenceRefs(evidenceRows);
    return {
      collision_risk: "high",
      novelty_cap: 6,
      total_cap: 55,
      reasons: ["Multiple verified evidence-backed papers overlap strongly with the idea terms."],
      defensible_gap: "Narrow the claim to a specific setting, dataset, measurement, or failure mode not covered by overlapping work.",
      evidence_refs: refs
    };
  }
  if (overlaps.length > 0) {
    const refs = evidenceRefs(evidenceRows).slice(0, 3);
    return {
      collision_risk: "medium",
      reasons: ["At least one verified evidence-backed paper overlaps with the idea terms."],
      defensible_gap: "Use the evidence refs to identify a narrower defensible gap.",
      evidence_refs: refs
    };
  }
  return {
    collision_risk: "low",
    reasons: ["No strong lexical overlap was detected in current candidates."],
    defensible_gap: "Keep novelty provisional until more verified related work is read.",
    evidence_refs: evidenceRefs(evidenceRows).slice(0, 3)
  };
}

export function noveltyMatrixMarkdown(assessment: NoveltyAssessment): string {
  return `# Novelty Gap Matrix\n\n- Collision risk: ${assessment.collision_risk}\n- Novelty cap: ${assessment.novelty_cap ?? "none"}\n- Total cap: ${assessment.total_cap ?? "none"}\n- Defensible gap: ${assessment.defensible_gap}\n\n## Reasons\n\n${assessment.reasons.map((reason) => `- ${reason}`).join("\n")}\n\n## Evidence Refs\n\n${assessment.evidence_refs.map((ref) => `- ${ref.paper_id}: page ${ref.page}, chunk ${ref.chunk_id}, quote "${ref.quote.replace(/"/g, "'").slice(0, 180)}"`).join("\n") || "- none"}\n`;
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
