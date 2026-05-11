import type { PdfChunkIndexEntry } from "../pdf/chunk.js";

export type EvidenceClaimType = "method" | "dataset" | "metric" | "baseline" | "limitation" | "result" | "threat" | "future_work";

export type ClaimEvidenceRow = {
  paper_id: string;
  claim: string;
  claim_type: EvidenceClaimType;
  required_evidence: string;
  planned_artifact: string;
  status: "verified" | "planned" | "missing";
  page?: string;
  section?: string;
  quote?: string;
  chunk_id?: string;
  confidence: number;
};

export function extractEvidenceRows(chunks: PdfChunkIndexEntry[]): ClaimEvidenceRow[] {
  const byPaper = new Map<string, PdfChunkIndexEntry[]>();
  for (const chunk of chunks) byPaper.set(chunk.paper_id, [...(byPaper.get(chunk.paper_id) ?? []), chunk]);
  return [...byPaper.entries()].map(([paperId, paperChunks]) => {
    const chunk = paperChunks.find((candidate) => candidate.text.length > 30) ?? paperChunks[0];
    return {
      paper_id: paperId,
      claim: chunk ? inferClaim(chunk.text) : "Verified paper evidence extracted from PDF chunk.",
      claim_type: chunk ? inferClaimType(chunk.text) : "method",
      required_evidence: "page, quote, and chunk id",
      planned_artifact: `docs/reference/paper_notes/${paperId}.md`,
      status: chunk ? "verified" : "missing",
      page: chunk ? String(chunk.page) : undefined,
      section: chunk ? inferSectionLabel(chunk.text) : undefined,
      quote: chunk?.text.slice(0, 240),
      chunk_id: chunk?.chunk_id,
      confidence: chunk ? evidenceConfidence(chunk) : 0
    };
  });
}

export function trustedEvidenceRows(rows: ClaimEvidenceRow[], chunks: PdfChunkIndexEntry[]): ClaimEvidenceRow[] {
  const chunkByKey = new Map(chunks.map((chunk) => [`${chunk.paper_id}:${chunk.page}:${chunk.chunk_id}`, chunk]));
  return rows.filter((row) => {
    if (row.status !== "verified") return true;
    if (!row.page || !row.quote || !row.chunk_id) return false;
    const chunk = chunkByKey.get(`${row.paper_id}:${Number(row.page)}:${row.chunk_id}`);
    if (!chunk) return false;
    return normalizeEvidenceText(chunk.text).includes(normalizeEvidenceText(row.quote));
  });
}

export function evidenceRowsMarkdown(rows: ClaimEvidenceRow[], chunks?: PdfChunkIndexEntry[]): Record<string, string> {
  const trustedRows = chunks ? trustedEvidenceRows(rows, chunks) : rows;
  const grouped = new Map<string, ClaimEvidenceRow[]>();
  for (const row of trustedRows) grouped.set(row.paper_id, [...(grouped.get(row.paper_id) ?? []), row]);
  const files: Record<string, string> = {};
  for (const [paperId, paperRows] of grouped) {
    const text = evidenceText(paperRows);
    files[`docs/reference/paper_notes/${paperId}.md`] = `# ${paperId}\n\n## Problem\n\n${inferSection(text, "problem")}\n\n## Method\n\n${inferSection(text, "method")}\n\n## Claims And Evidence\n\n${paperRows.map((row) => `- Claim: ${row.claim}\n  - Type: ${row.claim_type}\n  - Confidence: ${row.confidence}\n  - Page: ${row.page ?? "missing"}\n  - Section: ${row.section ?? "missing"}\n  - Quote: ${row.quote ?? "missing"}\n  - Chunk: ${row.chunk_id ?? "missing"}`).join("\n")}\n\n## Limitations\n\n${inferSection(text, "limitation")}\n\n## Analysis Confidence\n\n${paperRows.some((row) => row.page && row.quote && row.chunk_id) ? "medium" : "low"}\n`;
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

function inferClaimType(text: string): EvidenceClaimType {
  const lowered = text.toLowerCase();
  if (lowered.includes("dataset") || lowered.includes("benchmark")) return "dataset";
  if (lowered.includes("metric") || lowered.includes("accuracy") || lowered.includes("latency")) return "metric";
  if (lowered.includes("baseline")) return "baseline";
  if (lowered.includes("limitation")) return "limitation";
  if (lowered.includes("threat")) return "threat";
  if (lowered.includes("future work")) return "future_work";
  if (lowered.includes("result")) return "result";
  return "method";
}

function inferSectionLabel(text: string): string {
  const lowered = text.toLowerCase();
  if (lowered.includes("experiment") || lowered.includes("evaluation")) return "evaluation";
  if (lowered.includes("limitation") || lowered.includes("threat")) return "limitations";
  if (lowered.includes("method") || lowered.includes("approach") || lowered.includes("system")) return "method";
  if (lowered.includes("dataset") || lowered.includes("benchmark") || lowered.includes("metric")) return "evaluation";
  return "unknown";
}

function evidenceConfidence(chunk: PdfChunkIndexEntry): number {
  if (chunk.extraction_quality === "empty") return 0.2;
  if (chunk.extraction_quality === "weak") return 0.45;
  return 0.65;
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

export function evidenceRowsCsv(rows: ClaimEvidenceRow[], chunks?: PdfChunkIndexEntry[]): string {
  const trustedRows = chunks ? trustedEvidenceRows(rows, chunks) : rows;
  const header = ["paper_id", "claim", "claim_type", "confidence", "required_evidence", "planned_artifact", "status", "page", "section", "quote", "chunk_id"];
  return [header, ...trustedRows.map((row) => [row.paper_id, row.claim, row.claim_type, String(row.confidence), row.required_evidence, row.planned_artifact, row.status, row.page ?? "", row.section ?? "", row.quote ?? "", row.chunk_id ?? ""])]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
