import { searchAclAnthology } from "./adapters/acl-anthology.js";
import { searchArxiv } from "./adapters/arxiv.js";
import { searchCrossref } from "./adapters/crossref.js";
import { searchDblp } from "./adapters/dblp.js";
import { searchOpenAlex } from "./adapters/openalex.js";
import { searchSemanticScholar } from "./adapters/semantic-scholar.js";
import { dedupeCandidates } from "./dedupe.js";
import { rankCandidates } from "./rank.js";
import { isCcfACoreCandidate } from "./venue.js";
import { throwIfAborted } from "../../runtime/abort.js";
import type { LiteratureAdapterOptions, LiteratureAdapterResult, LiteratureSearchOptions, LiteratureSearchResult, LiteratureSource, PaperCandidate } from "./types.js";

export const defaultLiteratureSources: LiteratureSource[] = ["openalex", "crossref", "arxiv", "dblp", "semantic-scholar", "acl-anthology"];
const REQUIRED_CCF_A_CORE_PAPERS = 8;

export async function searchLiteratureDeterministic(options: LiteratureSearchOptions): Promise<LiteratureSearchResult> {
  throwIfAborted(options.signal);
  const queries = normalizeQueries(options);
  const limit = options.limit ?? 20;
  if (!options.allowNetwork) {
    return {
      candidates: [],
      warnings: queries.map((query) => `Network disabled. Search manually: ${query}`),
      ccf_gate: { eligible_core_count: 0, required_core_count: REQUIRED_CCF_A_CORE_PAPERS, preliminary_only: true },
      search_report: searchReport([], queries, [`Network disabled. Search manually: ${queries.join("; ")}`])
    };
  }
  const sources = normalizeSources(options.sources);
  const fetchImpl = options.fetchImpl ?? fetch;
  const perSourceLimit = Math.max(1, Math.ceil(limit / Math.max(1, Math.min(queries.length * sources.length, limit))));
  const results: LiteratureAdapterResult[] = [];
  let executedQueries = queries;
  await runQueries(queries, sources, perSourceLimit, fetchImpl, results, options.signal);
  let candidates = rankCandidates(dedupeCandidates(results.flatMap((result) => result.candidates)), options.idea ?? queries.join(" "), { targetVenues: options.targetVenues }).slice(0, limit);
  let ccfGate = ccfVenueGate(candidates);
  if (ccfGate.eligible_core_count < ccfGate.required_core_count) {
    const expandedQueries = expandedRecallQueries(queries);
    executedQueries = [...queries, ...expandedQueries];
    await runQueries(expandedQueries, sources, perSourceLimit, fetchImpl, results, options.signal);
    candidates = rankCandidates(dedupeCandidates(results.flatMap((result) => result.candidates)), options.idea ?? queries.join(" "), { targetVenues: options.targetVenues }).slice(0, limit);
    ccfGate = ccfVenueGate(candidates);
  }
  const warnings = results.flatMap((result) => result.warnings);
  if (ccfGate.preliminary_only) warnings.push(`Only ${ccfGate.eligible_core_count} qualified CCF-A main/full core papers found after expanded recall queries; at least ${ccfGate.required_core_count} are required before verified strict CCF-A novelty/scoring.`);
  return { candidates, ccf_gate: ccfGate, warnings, search_report: searchReport(candidates, executedQueries, warnings) };
}

export function searchReport(candidates: PaperCandidate[], queries: string[], warnings: string[] = []): string {
  return `# Literature Search Report

## Queries

${queries.map((query) => `- ${query}`).join("\n") || "- none"}

## Candidates

| Rank | Title | Year | Venue | CCF | Gate | Main/Full Eligible | Track | Novelty Risk | Provenance | Score | PDF | Inclusion Reason | Exclusion Reason | Reason |
| ---: | --- | ---: | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |
${(candidates.length ? candidates : []).map((candidate, index) => `| ${index + 1} | ${escapeCell(candidate.title)} | ${candidate.year ?? ""} | ${escapeCell(candidate.venue ?? "")} | ${candidate.ccf_rank ?? "unknown"} | ${candidate.ccf_gate_status ?? "excluded"} | ${candidate.main_track_eligible ? "yes" : "no"} | ${candidate.track_status ?? "unknown"} | ${candidate.novelty_risk ?? "unknown"} | ${(candidate.source_provenance ?? candidate.retrieval_sources).join("; ")} | ${candidate.relevance_score ?? ""} | ${candidate.pdf_status ?? (candidate.pdf_urls.length ? "available" : "unavailable")} | ${escapeCell(candidate.inclusion_reason ?? "")} | ${escapeCell(candidate.exclusion_reason ?? "")} | ${escapeCell(candidate.reason ?? "")} |`).join("\n") || "|  | No candidates yet |  |  |  |  |  |  |  |  |  |  |  |  |  |"}

## Warnings

${warnings.map((warning) => `- ${warning}`).join("\n") || "- none"}
`;
}

function ccfVenueGate(candidates: PaperCandidate[]): LiteratureSearchResult["ccf_gate"] {
  const eligibleCoreCount = candidates.filter(isCcfACoreCandidate).length;
  return {
    eligible_core_count: eligibleCoreCount,
    required_core_count: REQUIRED_CCF_A_CORE_PAPERS,
    preliminary_only: eligibleCoreCount < REQUIRED_CCF_A_CORE_PAPERS
  };
}

function normalizeQueries(options: LiteratureSearchOptions): string[] {
  return [...new Set([...(options.queries ?? []), options.query ?? ""].map((query) => query.trim()).filter(Boolean))];
}

async function runAdapter(source: LiteratureSource, options: LiteratureAdapterOptions): Promise<LiteratureAdapterResult> {
  if (source === "openalex") return searchOpenAlex(options);
  if (source === "crossref") return searchCrossref(options);
  if (source === "arxiv") return searchArxiv(options);
  if (source === "dblp") return searchDblp(options);
  if (source === "semantic-scholar") return searchSemanticScholar(options);
  return searchAclAnthology(options);
}

async function runQueries(queries: string[], sources: LiteratureSource[], perSourceLimit: number, fetchImpl: typeof fetch, results: LiteratureAdapterResult[], signal?: AbortSignal): Promise<void> {
  for (const query of queries) {
    throwIfAborted(signal);
    const adapterOptions: LiteratureAdapterOptions = { query, limit: perSourceLimit, fetchImpl, signal };
    for (const source of sources) {
      throwIfAborted(signal);
      const result = await runAdapter(source, adapterOptions);
      throwIfAborted(signal);
      results.push(result);
    }
  }
}

function expandedRecallQueries(queries: string[]): string[] {
  const expanded = queries.flatMap((query) => [
    `${query} survey`,
    `${query} baseline dataset metric`,
    `${query} related work benchmark`
  ]);
  const original = new Set(queries.map((query) => query.toLowerCase()));
  return [...new Set(expanded.map((query) => query.trim()).filter(Boolean))].filter((query) => !original.has(query.toLowerCase()));
}

export function normalizeSources(sources: LiteratureSource[] | undefined): LiteratureSource[] {
  if (!sources?.length) return defaultLiteratureSources;
  const allowed = new Set(defaultLiteratureSources);
  const invalid = sources.filter((source) => !allowed.has(source));
  if (invalid.length) throw new Error(`unknown literature source: ${invalid.join(", ")}`);
  return [...new Set(sources)];
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
