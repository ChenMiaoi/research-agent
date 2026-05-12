import type { IdeaBrief, RelatedWorkAnalysis, SearchPlan } from "../../agents/schemas.js";
import type { PaperCandidate } from "../literature/types.js";
import type { PdfChunkIndexEntry } from "../pdf/chunk.js";
import { trustedEvidenceRows, type ClaimEvidenceRow } from "./evidence-extract.js";

export type RelatedWorkSurvey = {
  markdown: string;
  clusterCount: number;
  verifiedPaperCount: number;
  reviewerExpectedBaselines: string[];
  reviewerExpectedDatasets: string[];
  reviewerExpectedMetrics: string[];
};

export function buildRelatedWorkSurvey(input: {
  ideaBrief: IdeaBrief;
  searchPlan: SearchPlan;
  candidates: PaperCandidate[];
  evidenceRows: ClaimEvidenceRow[];
  chunks?: PdfChunkIndexEntry[];
  noteArtifacts?: Record<string, string>;
  agentRelatedWork?: RelatedWorkAnalysis | null;
}): RelatedWorkSurvey {
  const rows = verifiedRows(input.evidenceRows, input.chunks, input.noteArtifacts);
  const candidatesByPaper = new Map(input.candidates.map((candidate) => [safePaperId(candidate.candidate_id), candidate]));
  const clusters = relatedWorkClusters(input.ideaBrief, input.searchPlan, input.agentRelatedWork).map((cluster) => {
    const matches = rows.filter((row) => cluster.terms.some((term) => evidenceText(row).includes(term))).slice(0, 8);
    return { ...cluster, rows: matches };
  });
  const baselines = signals(rows, ["baseline"], candidatesByPaper);
  const datasets = signals(rows, ["dataset", "benchmark", "corpus", "workload"], candidatesByPaper);
  const metrics = signals(rows, ["metric", "accuracy", "latency", "throughput", "precision", "recall", "f1"], candidatesByPaper);
  const verifiedPaperCount = new Set(rows.map((row) => row.paper_id)).size;
  return {
    markdown: surveyMarkdown({ clusters, rows, candidatesByPaper, baselines, datasets, metrics, verifiedPaperCount }),
    clusterCount: clusters.filter((cluster) => cluster.rows.length > 0).length,
    verifiedPaperCount,
    reviewerExpectedBaselines: baselines,
    reviewerExpectedDatasets: datasets,
    reviewerExpectedMetrics: metrics
  };
}

function surveyMarkdown(input: {
  clusters: Array<{ name: string; terms: string[]; rows: ClaimEvidenceRow[] }>;
  rows: ClaimEvidenceRow[];
  candidatesByPaper: Map<string, PaperCandidate>;
  baselines: string[];
  datasets: string[];
  metrics: string[];
  verifiedPaperCount: number;
}): string {
  return `# Related Work Survey

- Verified PDF-backed papers: ${input.verifiedPaperCount}
- Verified evidence rows: ${input.rows.length}

${input.clusters.map((cluster, index) => clusterMarkdown(index + 1, cluster, input.candidatesByPaper)).join("\n\n")}

## Reviewer-Expected Baselines

${markdownList(input.baselines, "No verified baseline signal yet.")}

## Reviewer-Expected Datasets / Metrics

### Datasets / Benchmarks

${markdownList(input.datasets, "No verified dataset or benchmark signal yet.")}

### Metrics

${markdownList(input.metrics, "No verified metric signal yet.")}
`;
}

function clusterMarkdown(index: number, cluster: { name: string; rows: ClaimEvidenceRow[] }, candidatesByPaper: Map<string, PaperCandidate>): string {
  const papers = unique(cluster.rows.map((row) => candidatesByPaper.get(row.paper_id)?.title ?? row.paper_id));
  const establishes = unique(cluster.rows.map((row) => evidenceSummary(row))).slice(0, 5);
  const unsolved = cluster.rows.length
    ? ["The current idea still needs a side-by-side delta against the closest paper note evidence."]
    : ["No verified paper-note evidence currently supports this cluster."];
  return `## Cluster ${index}: ${cluster.name}

${papers.map((paper) => `- Paper: ${paper}`).join("\n") || "- Paper: none verified yet"}

### What They Establish

${markdownList(establishes, "No verified evidence yet.")}

### What Remains Unsolved

${markdownList(unsolved, "No open gap identified yet.")}`;
}

function clusterDefinitions(brief: IdeaBrief, plan: SearchPlan): Array<{ name: string; terms: string[] }> {
  return [
    { name: "Direct Problem And Method Prior Work", terms: unique([...brief.method_keywords, ...brief.task_keywords, ...plan.core_concepts]).map((term) => term.toLowerCase()) },
    { name: "Benchmarks, Datasets, And Metrics", terms: ["benchmark", "dataset", "metric", "accuracy", "latency", "throughput", "precision", "recall", "f1"] },
    { name: "Baselines And Evaluation Protocols", terms: ["baseline", "comparison", "experiment", "evaluation", "ablation", "result"] },
    { name: "Limitations, Threats, And Failure Cases", terms: ["limitation", "threat", "failure", "weakness", "future work"] }
  ];
}

function relatedWorkClusters(
  brief: IdeaBrief,
  plan: SearchPlan,
  agentRelatedWork: RelatedWorkAnalysis | null | undefined
): Array<{ name: string; terms: string[] }> {
  const agentClusters = (agentRelatedWork?.topic_clusters ?? [])
    .map((cluster, index) => {
      const values = Object.values(cluster).map((value) => value.trim()).filter(Boolean);
      if (!values.length) return null;
      const name = cluster.name || cluster.cluster || cluster.topic || `Agent Cluster ${index + 1}`;
      return {
        name,
        terms: termsFromText(values.join(" "))
      };
    })
    .filter((cluster): cluster is { name: string; terms: string[] } => Boolean(cluster?.terms.length));
  return agentClusters.length ? agentClusters : clusterDefinitions(brief, plan);
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

function signals(rows: ClaimEvidenceRow[], terms: string[], candidatesByPaper: Map<string, PaperCandidate>): string[] {
  const loweredTerms = terms.map((term) => term.toLowerCase());
  return unique(rows
    .filter((row) => loweredTerms.some((term) => evidenceText(row).includes(term)))
    .map((row) => `${candidatesByPaper.get(row.paper_id)?.title ?? row.paper_id}: ${row.claim}`));
}

function evidenceText(row: ClaimEvidenceRow): string {
  return `${row.claim_type} ${row.claim} ${row.quote ?? ""} ${row.section ?? ""}`.toLowerCase();
}

function termsFromText(value: string): string[] {
  return unique(value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((term) => term.length > 3));
}

function evidenceSummary(row: ClaimEvidenceRow): string {
  return `${row.claim} (page ${row.page}, chunk ${row.chunk_id})`;
}

function markdownList(items: string[], fallback: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}
