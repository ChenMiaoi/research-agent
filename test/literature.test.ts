import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeCandidates } from "../src/skills/literature/dedupe.js";
import { rankCandidates } from "../src/skills/literature/rank.js";
import { searchLiteratureAsync, paperCandidateToRecord } from "../src/literature.js";
import { normalizeSources } from "../src/skills/literature/search.js";
import type { LiteraturePaperCandidate } from "../src/literature.js";

test("literature search orchestrates mocked adapters without real network", async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("openalex.org")) {
      return json({
        results: [
          {
            id: "https://openalex.org/W1",
            title: "Agent Benchmark Evaluation",
            publication_year: 2026,
            doi: "https://doi.org/10.1000/agent",
            authorships: [{ author: { display_name: "Ada Lovelace" } }],
            primary_location: { source: { display_name: "NeurIPS" }, landing_page_url: "https://example.org/agent", pdf_url: "https://example.org/agent.pdf" },
            open_access: { oa_url: "https://example.org/agent.pdf" }
          }
        ]
      });
    }
    if (url.includes("crossref.org")) {
      return json({
        message: {
          items: [
            {
              DOI: "10.1000/agent",
              title: ["Agent Benchmark Evaluation"],
              author: [{ given: "Ada", family: "Lovelace" }],
              published: { "date-parts": [[2026]] },
              "container-title": ["NeurIPS"],
              URL: "https://doi.org/10.1000/agent"
            }
          ]
        }
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await searchLiteratureAsync({
    queries: ["agent benchmark"],
    allowNetwork: true,
    limit: 5,
    sources: ["openalex", "crossref"],
    idea: "agent benchmark evaluation",
    fetchImpl
  });
  assert.equal(seen.length >= 2, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.doi, "10.1000/agent");
  assert.equal(result.candidates[0]?.retrieval_sources.sort().join(","), "crossref,openalex");
  assert.match(result.search_report, /Agent Benchmark Evaluation/);
  assert.match(result.search_report, /baseline dataset metric/);
  const record = paperCandidateToRecord(result.candidates[0]!, 0);
  assert.equal(record.title, "Agent Benchmark Evaluation");
  assert.equal(record.authors[0], "Ada Lovelace");
});

test("dedupe and ranking prefer matching, recent, PDF-backed candidates", () => {
  const candidates: LiteraturePaperCandidate[] = [
    candidate({ title: "Unrelated Systems Paper", year: 2018, pdf_urls: [] }),
    candidate({ title: "Agent Benchmark Evaluation", year: 2026, doi: "10.1000/agent", pdf_urls: ["https://example.org/a.pdf"] }),
    candidate({ title: "Agent Benchmark Evaluation", year: 2026, openalex_id: "W1", pdf_urls: [] })
  ];
  const deduped = dedupeCandidates(candidates);
  assert.equal(deduped.length, 2);
  const ranked = rankCandidates(deduped, "agent benchmark evaluation");
  assert.equal(ranked[0]?.title, "Agent Benchmark Evaluation");
  assert.ok((ranked[0]?.relevance_score ?? 0) > (ranked[1]?.relevance_score ?? 0));
});

test("literature search records offline manual tasks when network is disabled", async () => {
  const result = await searchLiteratureAsync({ query: "agent benchmark", allowNetwork: false });
  assert.equal(result.candidates.length, 0);
  assert.match(result.warnings[0] ?? "", /Network disabled/);
});

test("literature source validation rejects unknown adapters", () => {
  assert.throws(() => normalizeSources(["openalex", "unknown" as never]), /unknown literature source/);
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function candidate(overrides: Partial<LiteraturePaperCandidate>): LiteraturePaperCandidate {
  return {
    candidate_id: overrides.title?.toLowerCase().replace(/\s+/g, "-") ?? "candidate",
    title: "Candidate",
    authors: ["Ada Lovelace"],
    year: 2024,
    source_urls: ["https://example.org/paper"],
    pdf_urls: [],
    retrieval_sources: ["test"],
    retrieval_queries: ["agent benchmark"],
    confidence: "medium",
    ...overrides
  };
}
