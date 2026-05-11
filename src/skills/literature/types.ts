export type LiteratureSource = "openalex" | "crossref" | "arxiv" | "dblp" | "semantic-scholar" | "acl-anthology";
export type CandidateCcfRank = "A" | "B" | "C" | "unknown";
export type CandidateVenueMatch = "target" | "primary" | "secondary" | "ccf_a" | "known" | "unknown";
export type CandidateTrackStatus = "main_conference" | "journal" | "workshop" | "demo" | "short_paper" | "unknown";
export type CandidateNoveltyRisk = "high" | "medium" | "low" | "unknown";
export type CandidatePdfStatus = "available" | "unavailable" | "needs_approval" | "downloaded";

export type PaperCandidate = {
  candidate_id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue?: string;
  doi?: string;
  arxiv_id?: string;
  openalex_id?: string;
  dblp_key?: string;
  semantic_scholar_id?: string;
  source_urls: string[];
  pdf_urls: string[];
  abstract?: string;
  retrieval_sources: string[];
  retrieval_queries: string[];
  confidence: "high" | "medium" | "low";
  relevance_score?: number;
  ccf_rank?: CandidateCcfRank;
  venue_match?: CandidateVenueMatch;
  track_status?: CandidateTrackStatus;
  novelty_risk?: CandidateNoveltyRisk;
  reason?: string;
  pdf_status?: CandidatePdfStatus;
};

export type LiteratureAdapterOptions = {
  query: string;
  limit: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
};

export type LiteratureAdapterResult = {
  source: LiteratureSource;
  candidates: PaperCandidate[];
  warnings: string[];
};

export type LiteratureSearchOptions = {
  allowNetwork?: boolean;
  queries?: string[];
  query?: string;
  sources?: LiteratureSource[];
  limit?: number;
  idea?: string;
  targetVenues?: string[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export type LiteratureSearchResult = {
  candidates: PaperCandidate[];
  warnings: string[];
  search_report: string;
};
