import type { PdfChunkIndexEntry } from "../pdf/chunk.js";

export type ClaimEvidenceRow = {
  paper_id: string;
  claim: string;
  required_evidence: string;
  planned_artifact: string;
  status: "verified" | "planned" | "missing";
  page?: string;
  quote?: string;
  chunk_id?: string;
};

export function extractEvidenceRows(chunks: PdfChunkIndexEntry[]): ClaimEvidenceRow[] {
  const byPaper = new Map<string, PdfChunkIndexEntry[]>();
  for (const chunk of chunks) byPaper.set(chunk.paper_id, [...(byPaper.get(chunk.paper_id) ?? []), chunk]);
  return [...byPaper.entries()].map(([paperId, paperChunks]) => {
    const chunk = paperChunks.find((candidate) => candidate.text.length > 30) ?? paperChunks[0];
    return {
      paper_id: paperId,
      claim: chunk ? inferClaim(chunk.text) : "Verified paper evidence extracted from PDF chunk.",
      required_evidence: "page, quote, and chunk id",
      planned_artifact: `docs/reference/paper_notes/${paperId}.md`,
      status: chunk ? "verified" : "missing",
      page: chunk ? String(chunk.page) : undefined,
      quote: chunk?.text.slice(0, 240),
      chunk_id: chunk?.chunk_id
    };
  });
}

export function evidenceRowsMarkdown(rows: ClaimEvidenceRow[]): Record<string, string> {
  const grouped = new Map<string, ClaimEvidenceRow[]>();
  for (const row of rows) grouped.set(row.paper_id, [...(grouped.get(row.paper_id) ?? []), row]);
  const files: Record<string, string> = {};
  for (const [paperId, paperRows] of grouped) {
    const text = evidenceText(paperRows);
    files[`docs/reference/paper_notes/${paperId}.md`] = `# ${paperId}\n\n## Problem\n\n${inferSection(text, "problem")}\n\n## Method\n\n${inferSection(text, "method")}\n\n## Claims And Evidence\n\n${paperRows.map((row) => `- Claim: ${row.claim}\n  - Page: ${row.page ?? "missing"}\n  - Quote: ${row.quote ?? "missing"}\n  - Chunk: ${row.chunk_id ?? "missing"}`).join("\n")}\n\n## Limitations\n\n${inferSection(text, "limitation")}\n\n## Analysis Confidence\n\n${paperRows.some((row) => row.page && row.quote && row.chunk_id) ? "medium" : "low"}\n`;
  }
  return files;
}

export function evidenceText(rows: ClaimEvidenceRow[]): string {
  return rows.map((row) => `${row.claim} ${row.quote ?? ""}`).join(" ").toLowerCase();
}

function inferClaim(text: string): string {
  const lowered = text.toLowerCase();
  if (lowered.includes("baseline")) return "PDF evidence mentions baseline comparison.";
  if (lowered.includes("dataset") || lowered.includes("benchmark")) return "PDF evidence mentions dataset or benchmark.";
  if (lowered.includes("metric") || lowered.includes("accuracy") || lowered.includes("latency")) return "PDF evidence mentions metric.";
  if (lowered.includes("limitation")) return "PDF evidence mentions limitation.";
  return "Verified paper evidence extracted from PDF chunk.";
}

function inferSection(text: string, kind: "problem" | "method" | "limitation"): string {
  if (!text.trim()) return `No ${kind} evidence was extracted; analysis confidence is low.`;
  const sentences = text.split(/[.!?]\s+/).map((part) => part.trim()).filter(Boolean);
  const markers: Record<typeof kind, string[]> = {
    problem: ["problem", "challenge", "need", "gap", "benchmark"],
    method: ["method", "approach", "model", "algorithm", "system", "framework"],
    limitation: ["limitation", "fail", "weakness", "future work", "threat"]
  };
  const match = sentences.find((sentence) => markers[kind].some((marker) => sentence.includes(marker)));
  return match ? `${capitalize(kind)} evidence: ${match}.` : `The extracted evidence does not state a distinct ${kind}; analysis confidence is low.`;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function evidenceRowsCsv(rows: ClaimEvidenceRow[]): string {
  const header = ["paper_id", "claim", "required_evidence", "planned_artifact", "status", "page", "quote", "chunk_id"];
  return [header, ...rows.map((row) => [row.paper_id, row.claim, row.required_evidence, row.planned_artifact, row.status, row.page ?? "", row.quote ?? "", row.chunk_id ?? ""])]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
