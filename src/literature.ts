import type { PaperCandidate } from "./skills/literature/types.js";
import type { LiteratureSearchOptions, LiteratureSearchResult } from "./skills/literature/types.js";
import { searchLiteratureDeterministic } from "./skills/literature/search.js";

export type PaperRecord = {
  paper_id: string;
  title: string;
  venue: string;
  year: number;
  authors: string[];
  source_url: string;
  bibtex_key: string;
  abstract?: string;
  doi?: string;
  openalex_id?: string;
  dblp_key?: string;
  arxiv_id?: string;
  main_problem?: string;
  core_method?: string;
  main_claim?: string;
  evidence?: string;
  datasets?: string;
  baselines?: string;
  metrics?: string;
  strengths?: string;
  weaknesses?: string;
  limitations?: string;
  relation_to_current_idea?: string;
  difference_from_current_idea?: string;
  collision_risk?: string;
  useful_for?: string;
  pdf_path?: string;
  pdf_sha256?: string;
  pdf_status?: "downloaded" | "not_available" | "failed" | "skipped_license";
  evidence_refs?: Array<{
    page: number;
    quote: string;
    chunk_id: string;
    purpose: string;
  }>;
  analysis_confidence?: "high" | "medium" | "low";
};

export type VerifiedPaperRecord = PaperRecord & {
  evidence_refs: NonNullable<PaperRecord["evidence_refs"]>;
  analysis_confidence: "high" | "medium" | "low";
};

export type { PaperCandidate as LiteraturePaperCandidate, LiteratureSearchOptions, LiteratureSearchResult };

export async function searchLiteratureAsync(options: LiteratureSearchOptions): Promise<LiteratureSearchResult> {
  return searchLiteratureDeterministic(options);
}

export function validatePaper(record: PaperRecord): string[] {
  const errors: string[] = [];
  if (!record.paper_id) errors.push("paper_id is required");
  if (!record.title) errors.push("title is required");
  if (record.year < 1800 || record.year > 2100) errors.push("year is out of range");
  if (!record.authors.length) errors.push("at least one author is required");
  if (!/^https?:\/\//.test(record.source_url)) errors.push("source_url must be absolute");
  if (!record.bibtex_key) errors.push("bibtex_key is required");
  return errors;
}

export function verifiedRecords(records: PaperRecord[] = []): PaperRecord[] {
  return records.filter((record) => validatePaper(record).length === 0);
}

export function searchLiterature(query: string, options: { allowNetwork?: boolean; limit?: number } = {}): [PaperRecord[], string[]] {
  if (!options.allowNetwork) return [[], [`Network disabled. Search manually: ${query}`]];
  return [[], [`Use searchLiteratureAsync() for network search. Search manually if running in a synchronous context: ${query}`]];
}

export function paperCandidateToRecord(candidate: PaperCandidate, index = 0): PaperRecord {
  const year = candidate.year ?? new Date().getUTCFullYear();
  return {
    paper_id: slugPart(candidate.candidate_id || candidate.title),
    title: candidate.title,
    venue: candidate.venue ?? "unknown",
    year,
    authors: candidate.authors.length ? candidate.authors : ["Unknown"],
    source_url: candidate.source_urls[0] ?? "https://example.invalid/unverified-paper",
    bibtex_key: bibtexKey(candidate, index),
    abstract: candidate.abstract,
    doi: candidate.doi,
    openalex_id: candidate.openalex_id,
    dblp_key: candidate.dblp_key,
    arxiv_id: candidate.arxiv_id
  };
}

export function relatedWorkCsv(records: PaperRecord[] = []): string {
  const rows = [relatedHeader()];
  const verified = verifiedRecords(records);
  rows.push(...(verified.length ? verified.map(recordToRow) : [placeholderRow()]));
  return csv(rows);
}

export function referencesBib(records: PaperRecord[] = []): string {
  const verified = verifiedRecords(records);
  if (!verified.length) return "% Add only verified BibTeX entries.\n% Do not invent paper titles, authors, venues, years, or URLs.\n";
  return verified.map((record) => bibtex(record).trim()).join("\n\n") + "\n";
}

export function literatureTasksMd(tasks: string[] = []): string {
  const taskList = tasks.length
    ? tasks
    : [
        "Add verified papers from DBLP, OpenAlex, Crossref, arXiv, venue pages, or publisher pages.",
        "Record source URLs and BibTeX before using citations in paper text."
      ];
  return `# Literature Search Tasks\n\n${taskList.map((task) => `- ${task}`).join("\n")}\n`;
}

export function bibtex(record: PaperRecord): string {
  const fields = [
    `  title = {${record.title.replace(/[{}]/g, "")}}`,
    `  author = {${record.authors.join(" and ")}}`,
    `  year = {${record.year}}`,
    record.venue ? `  booktitle = {${record.venue}}` : "",
    record.doi ? `  doi = {${record.doi}}` : "",
    `  url = {${record.source_url}}`
  ].filter(Boolean);
  return `@inproceedings{${record.bibtex_key},\n${fields.join(",\n")}\n}\n`;
}

function recordToRow(record: PaperRecord): string[] {
  return [
    record.paper_id,
    record.title,
    record.venue,
    String(record.year),
    record.authors.join("; "),
    record.main_problem ?? "TODO: verify from paper",
    record.core_method ?? "TODO: verify from paper",
    record.main_claim ?? "TODO: verify from paper",
    record.evidence ?? "TODO: verify from paper",
    record.datasets ?? "TODO: verify from paper",
    record.baselines ?? "TODO: verify from paper",
    record.metrics ?? "TODO: verify from paper",
    record.strengths ?? "TODO: verify from paper",
    record.weaknesses ?? "TODO: verify from paper",
    record.limitations ?? "TODO: verify from paper",
    record.relation_to_current_idea ?? "TODO: analyst review required",
    record.difference_from_current_idea ?? "TODO: analyst review required",
    record.collision_risk ?? "Unknown until analyst review",
    record.useful_for ?? "TODO: analyst review required",
    record.source_url,
    record.bibtex_key,
    bibtex(record).replace(/\n/g, "\\n")
  ];
}

function relatedHeader(): string[] {
  return [
    "paper_id",
    "title",
    "venue",
    "year",
    "authors",
    "main_problem",
    "core_method",
    "main_claim",
    "evidence",
    "datasets",
    "baselines",
    "metrics",
    "strengths",
    "weaknesses",
    "limitations",
    "relation_to_current_idea",
    "difference_from_current_idea",
    "collision_risk",
    "useful_for",
    "source_url",
    "bibtex_key",
    "bibtex"
  ];
}

function placeholderRow(): string[] {
  return ["TODO", "Add only verified papers", ...Array(20).fill("TODO")].slice(0, 22);
}

export function csv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\n") + "\n";
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function bibtexKey(candidate: PaperCandidate, index: number): string {
  const author = slugPart(candidate.authors[0] ?? "paper");
  const year = candidate.year ?? "nd";
  const title = slugPart(candidate.title).split("-").slice(0, 3).join("");
  return `${author}${year}${title || index + 1}`.replace(/[^a-zA-Z0-9:_-]/g, "");
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "paper";
}
