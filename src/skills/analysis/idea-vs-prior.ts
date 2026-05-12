import type { PaperCandidate } from "../literature/types.js";
import type { PdfChunkIndexEntry } from "../pdf/chunk.js";
import { trustedEvidenceRows, type ClaimEvidenceRow } from "./evidence-extract.js";
import type { NoveltyAssessment } from "./novelty-matrix.js";

export type IdeaVsPriorWork = {
  markdown: string;
  collisionRisk: "high" | "medium" | "low";
  rows: Array<{
    paperId: string;
    priorWork: string;
    similarity: string;
    difference: string;
    collisionRisk: "high" | "medium" | "low";
    requiredFix: string;
  }>;
};

export function buildIdeaVsPriorWork(input: {
  idea: string;
  candidates: PaperCandidate[];
  evidenceRows: ClaimEvidenceRow[];
  chunks?: PdfChunkIndexEntry[];
  novelty: NoveltyAssessment;
  noteArtifacts?: Record<string, string>;
}): IdeaVsPriorWork {
  const rows = verifiedRows(input.evidenceRows, input.chunks, input.noteArtifacts);
  const candidatesByPaper = new Map(input.candidates.map((candidate) => [safePaperId(candidate.candidate_id), candidate]));
  const ideaTerms = terms(input.idea);
  const rowsByPaper = groupRowsByPaper(rows);
  const matrixRows = [...rowsByPaper.entries()].map(([paperId, paperRows]) => {
    const candidate = candidatesByPaper.get(paperId);
    const scoredRows = paperRows.map((row) => {
      const score = overlap(ideaTerms, `${row.claim} ${row.quote ?? ""}`);
      return { row, score, risk: rowRisk(score, row, input.novelty) };
    });
    const highest = highestRiskRow(scoredRows);
    const score = Math.max(...scoredRows.map((item) => item.score), 0);
    const risk = highest?.risk ?? "low";
    return {
      paperId,
      priorWork: candidate?.title ?? paperId,
      similarity: similarityText(score, paperRows),
      difference: differenceText(input.novelty, paperRows),
      collisionRisk: risk,
      requiredFix: requiredFix(risk, highest?.row ?? paperRows[0]!)
    };
  });
  const collisionRisk = combinedRisk(matrixRows.map((row) => row.collisionRisk), input.novelty.collision_risk);
  return {
    markdown: ideaVsPriorMarkdown(matrixRows, collisionRisk),
    collisionRisk,
    rows: matrixRows
  };
}

function ideaVsPriorMarkdown(rows: IdeaVsPriorWork["rows"], collisionRisk: "high" | "medium" | "low"): string {
  return `# Idea vs Prior Work

- Overall collision risk: ${collisionRisk}

| Prior Work | Similarity | Difference | Collision Risk | Required Fix |
| ---------- | ---------- | ---------- | -------------- | ------------ |
${rows.map((row) => `| ${escapeCell(row.priorWork)} | ${escapeCell(row.similarity)} | ${escapeCell(row.difference)} | ${row.collisionRisk} | ${escapeCell(row.requiredFix)} |`).join("\n") || "| No verified prior work yet | Blocked by missing paper-note evidence | Read PDFs and write verified paper notes | low | Complete the selected/core paper-note set |"}
`;
}

function verifiedRows(rows: ClaimEvidenceRow[], chunks: PdfChunkIndexEntry[] | undefined, noteArtifacts: Record<string, string> | undefined): ClaimEvidenceRow[] {
  const trusted = chunks ? trustedEvidenceRows(rows, chunks) : rows;
  const notePaths = Object.keys(noteArtifacts ?? {}).filter((path) => /^docs\/reference\/paper_notes\/.+\.md$/.test(path));
  const verifiedNoteIds = new Set(
    Object.entries(noteArtifacts ?? {})
      .filter(([, markdown]) => /evidence_status\s*=\s*verified/i.test(markdown))
      .map(([path]) => /^docs\/reference\/paper_notes\/(.+)\.md$/.exec(path)?.[1])
      .filter((value): value is string => Boolean(value))
  );
  return trusted.filter((row) =>
    row.status === "verified" &&
    Boolean(row.page && row.quote && row.chunk_id) &&
    (!notePaths.length || verifiedNoteIds.has(row.paper_id))
  );
}

function groupRowsByPaper(rows: ClaimEvidenceRow[]): Map<string, ClaimEvidenceRow[]> {
  const grouped = new Map<string, ClaimEvidenceRow[]>();
  for (const row of rows) grouped.set(row.paper_id, [...(grouped.get(row.paper_id) ?? []), row]);
  return grouped;
}

function highestRiskRow(rows: Array<{ row: ClaimEvidenceRow; score: number; risk: "high" | "medium" | "low" }>): { row: ClaimEvidenceRow; score: number; risk: "high" | "medium" | "low" } | null {
  const rank = { high: 2, medium: 1, low: 0 } as const;
  return [...rows].sort((left, right) => rank[right.risk] - rank[left.risk] || right.score - left.score)[0] ?? null;
}

function rowRisk(score: number, row: ClaimEvidenceRow, novelty: NoveltyAssessment): "high" | "medium" | "low" {
  if (novelty.collision_risk === "high" && score > 0.3) return "high";
  if (score > 0.45) return "high";
  if (score > 0.2 || /benchmark|dataset|baseline|metric|framework/i.test(`${row.claim} ${row.quote ?? ""}`)) return "medium";
  return "low";
}

function combinedRisk(risks: Array<"high" | "medium" | "low">, noveltyRisk: NoveltyAssessment["collision_risk"]): "high" | "medium" | "low" {
  if (risks.includes("high") || noveltyRisk === "high") return "high";
  if (risks.includes("medium") || noveltyRisk === "medium") return "medium";
  return "low";
}

function similarityText(score: number, rows: ClaimEvidenceRow[]): string {
  const bucket = score > 0.45 ? "High lexical overlap" : score > 0.2 ? "Moderate overlap" : "Low direct overlap";
  const refs = rows.map((row) => `p.${row.page}/chunk ${row.chunk_id}`).join("; ");
  return `${bucket}; evidence refs ${refs}`;
}

function differenceText(novelty: NoveltyAssessment, rows: ClaimEvidenceRow[]): string {
  const matchingDeltas = novelty.dimension_deltas.filter((delta) =>
    delta.evidence_refs.some((ref) => rows.some((row) => ref.paper_id === row.paper_id && ref.chunk_id === row.chunk_id))
  );
  const deltas = [...new Set(matchingDeltas.map((delta) => delta.idea_delta).filter(Boolean))];
  return deltas.join("; ") || "Difference must be stated against this verified paper-note evidence.";
}

function requiredFix(risk: "high" | "medium" | "low", row: ClaimEvidenceRow): string {
  if (risk === "high") return `Narrow or change the claim against ${row.paper_id} page ${row.page}.`;
  if (risk === "medium") return `Add a side-by-side contrast citing ${row.paper_id} page ${row.page}.`;
  return "Keep the contrast in related work and monitor as more PDFs are read.";
}

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((term) => term.length > 3))];
}

function overlap(ideaTerms: string[], text: string): number {
  if (!ideaTerms.length) return 0;
  const lowered = text.toLowerCase();
  return ideaTerms.filter((term) => lowered.includes(term)).length / ideaTerms.length;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}
