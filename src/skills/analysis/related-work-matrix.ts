import type { PaperCandidate } from "../literature/types.js";
import type { PdfManifestRecord } from "../pdf/provenance.js";
import type { ClaimEvidenceRow } from "./evidence-extract.js";

export function relatedWorkMatrixCsv(candidates: PaperCandidate[], manifest: PdfManifestRecord[], evidenceRows: ClaimEvidenceRow[]): string {
  const pdfByPaper = new Map(manifest.map((record) => [record.paper_id, record]));
  const evidenceByPaper = new Map(evidenceRows.map((row) => [row.paper_id, row]));
  const rows = [
    ["paper_id", "title", "year", "venue", "ccf_rank", "venue_match", "track_status", "pdf_status", "evidence_page", "evidence_quote", "evidence_chunk_id", "baseline_signal", "dataset_signal", "metric_signal", "collision_risk"],
    ...candidates.map((candidate) => {
      const paperId = safePaperId(candidate.candidate_id);
      const evidence = evidenceByPaper.get(paperId);
      const text = `${evidence?.claim ?? ""} ${evidence?.quote ?? ""}`.toLowerCase();
      return [
        paperId,
        candidate.title,
        String(candidate.year ?? ""),
        candidate.venue ?? "",
        candidate.ccf_rank ?? "unknown",
        candidate.venue_match ?? "unknown",
        candidate.track_status ?? "unknown",
        pdfByPaper.get(paperId)?.status ?? candidate.pdf_status ?? "not_available",
        evidence?.page ?? "",
        evidence?.quote ?? "",
        evidence?.chunk_id ?? "",
        yesNo(text.includes("baseline")),
        yesNo(text.includes("dataset") || text.includes("benchmark")),
        yesNo(text.includes("metric") || text.includes("accuracy") || text.includes("latency")),
        collisionRisk(text)
      ];
    })
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function topicClustersMarkdown(candidates: PaperCandidate[]): string {
  const clusters = [
    { name: "Benchmarks and evaluation", terms: ["benchmark", "evaluation", "metric", "dataset"] },
    { name: "Systems and runtime", terms: ["system", "runtime", "latency", "throughput"] },
    { name: "Security and safety", terms: ["security", "attack", "defense", "privacy"] },
    { name: "Methods and agents", terms: ["agent", "model", "planning", "tool"] }
  ];
  const rows = clusters.map((cluster) => {
    const papers = candidates.filter((candidate) => cluster.terms.some((term) => `${candidate.title} ${candidate.abstract ?? ""}`.toLowerCase().includes(term))).slice(0, 8);
    return `| ${cluster.name} | ${papers.length} | ${papers.map((paper) => paper.title).join("; ") || "none yet"} |`;
  });
  return `# Topic Clusters\n\n| Cluster | Papers | Representative titles |\n| --- | ---: | --- |\n${rows.join("\n")}\n`;
}

function collisionRisk(text: string): string {
  if (text.includes("survey") || text.includes("benchmark") || text.includes("framework")) return "medium";
  return "unknown";
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
