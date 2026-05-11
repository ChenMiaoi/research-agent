import type { PaperCandidate } from "./types.js";

export function dedupeCandidates(candidates: PaperCandidate[]): PaperCandidate[] {
  const merged: PaperCandidate[] = [];
  for (const candidate of candidates) {
    const existing = merged.find((item) => samePaper(item, candidate));
    if (!existing) {
      merged.push({ ...candidate });
      continue;
    }
    existing.authors = union(existing.authors, candidate.authors);
    existing.source_urls = union(existing.source_urls, candidate.source_urls);
    existing.pdf_urls = union(existing.pdf_urls, candidate.pdf_urls);
    existing.retrieval_sources = union(existing.retrieval_sources, candidate.retrieval_sources);
    existing.retrieval_queries = union(existing.retrieval_queries, candidate.retrieval_queries);
    existing.venue ||= candidate.venue;
    existing.year ??= candidate.year;
    existing.doi ||= candidate.doi;
    existing.arxiv_id ||= candidate.arxiv_id;
    existing.openalex_id ||= candidate.openalex_id;
    existing.dblp_key ||= candidate.dblp_key;
    existing.semantic_scholar_id ||= candidate.semantic_scholar_id;
    existing.abstract ||= candidate.abstract;
    existing.ccf_rank = best(existing.ccf_rank, candidate.ccf_rank, { A: 4, B: 3, C: 2, unknown: 1 });
    existing.venue_match = best(existing.venue_match, candidate.venue_match, { target: 6, primary: 5, secondary: 4, ccf_a: 3, known: 2, unknown: 1 });
    existing.track_status = trackStatus(existing.track_status, candidate.track_status);
    existing.novelty_risk = best(existing.novelty_risk, candidate.novelty_risk, { high: 4, medium: 3, low: 2, unknown: 1 });
    existing.pdf_status = best(existing.pdf_status, candidate.pdf_status, { downloaded: 4, available: 3, needs_approval: 2, unavailable: 1 });
    existing.reason = mergeReason(existing.reason, candidate.reason);
    existing.confidence = confidenceRank(existing.confidence) >= confidenceRank(candidate.confidence) ? existing.confidence : candidate.confidence;
  }
  return merged;
}

export function normalizedTitle(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function samePaper(a: PaperCandidate, b: PaperCandidate): boolean {
  if (a.doi && b.doi && normalizeDoi(a.doi) === normalizeDoi(b.doi)) return true;
  if (a.arxiv_id && b.arxiv_id && a.arxiv_id.toLowerCase() === b.arxiv_id.toLowerCase()) return true;
  const titleA = normalizedTitle(a.title);
  const titleB = normalizedTitle(b.title);
  if (titleA && titleA === titleB) return true;
  if (titleSimilarity(titleA, titleB) >= 0.92 && yearClose(a.year, b.year)) return true;
  return false;
}

function normalizeDoi(value: string): string {
  return value.toLowerCase().replace(/^https?:\/\/doi\.org\//, "").trim();
}

function titleSimilarity(a: string, b: string): number {
  const left = new Set(a.split(/\s+/).filter(Boolean));
  const right = new Set(b.split(/\s+/).filter(Boolean));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((word) => right.has(word)).length;
  return intersection / Math.max(left.size, right.size);
}

function yearClose(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= 1;
}

function union<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])];
}

function best<T extends string>(left: T | undefined, right: T | undefined, rank: Record<T, number>): T | undefined {
  if (!left) return right;
  if (!right) return left;
  return rank[left] >= rank[right] ? left : right;
}

function trackStatus(
  left: PaperCandidate["track_status"],
  right: PaperCandidate["track_status"]
): PaperCandidate["track_status"] {
  const rank = { main_conference: 5, journal: 5, unknown: 4, short_paper: 3, demo: 2, workshop: 1 };
  if (!left) return right;
  if (!right) return left;
  return rank[left] <= rank[right] ? left : right;
}

function mergeReason(left: string | undefined, right: string | undefined): string | undefined {
  const parts = [...new Set([...(left ? left.split("; ") : []), ...(right ? right.split("; ") : [])].filter(Boolean))];
  return parts.length ? parts.join("; ") : undefined;
}

function confidenceRank(value: PaperCandidate["confidence"]): number {
  return { low: 1, medium: 2, high: 3 }[value];
}
