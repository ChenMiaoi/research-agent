import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeCandidates } from "../src/skills/literature/dedupe.js";
import { rankCandidates } from "../src/skills/literature/rank.js";
import { enrichCandidate, resolveVenue } from "../src/skills/literature/venue.js";
import { searchLiterature, searchLiteratureAsync, paperCandidateToRecord } from "../src/literature.js";
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
  assert.equal(result.candidates[0]?.ccf_rank, "A");
  assert.equal(result.candidates[0]?.ccf_gate_status, "included");
  assert.equal(result.candidates[0]?.main_track_eligible, true);
  assert.equal(result.ccf_gate.preliminary_only, true);
  assert.equal(result.ccf_gate.required_core_count, 8);
  assert.equal(result.candidates[0]?.venue_match, "primary");
  assert.equal(result.candidates[0]?.track_status, "main_conference");
  assert.equal(result.candidates[0]?.pdf_status, "available");
  assert.match(result.search_report, /Agent Benchmark Evaluation/);
  assert.match(result.search_report, /Main\/Full Eligible/);
  assert.match(result.search_report, /Inclusion Reason/);
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

test("venue enrichment normalizes CCF-A aliases and detects ineligible tracks", () => {
  const resolved = resolveVenue("Conference on Neural Information Processing Systems");
  assert.equal(resolved?.canonical, "NeurIPS");
  assert.equal(resolveVenue("NIPS")?.canonical, "NeurIPS");
  assert.equal(resolveVenue("ICMLA"), null);
  assert.equal(resolveVenue("Fake NeurIPS Symposium"), null);
  assert.equal(resolveVenue("ACL Anthology"), null);
  const main = enrichCandidate(candidate({
    title: "Agent Benchmark Evaluation",
    venue: "Conference on Neural Information Processing Systems",
    pdf_urls: ["https://example.org/a.pdf"],
    abstract: "Agent benchmark evaluation with datasets and metrics"
  }), {
    idea: "agent benchmark evaluation",
    targetVenues: ["NeurIPS"]
  });
  assert.equal(main.venue, "NeurIPS");
  assert.equal(main.ccf_rank, "A");
  assert.equal(main.venue_match, "target");
  assert.equal(main.track_status, "main_conference");
  assert.equal(main.main_track_eligible, true);
  assert.equal(main.ccf_gate_status, "included");
  assert.match(main.inclusion_reason ?? "", /main\/full\/regular eligible/);
  assert.ok(main.source_provenance?.includes("ccf_seed"));
  assert.equal(main.novelty_risk, "high");
  assert.match(main.reason ?? "", /CCF-A/);

  const workshop = enrichCandidate(candidate({
    title: "Agent Benchmark Workshop Paper",
    venue: "NeurIPS Workshop",
    abstract: "Agent benchmark evaluation",
    pdf_urls: []
  }), {
    idea: "agent benchmark evaluation",
    targetVenues: ["NeurIPS"]
  });
  assert.equal(workshop.venue, "NeurIPS");
  assert.equal(workshop.track_status, "workshop");
  assert.equal(workshop.main_track_eligible, false);
  assert.equal(workshop.ccf_gate_status, "excluded");
  assert.match(workshop.exclusion_reason ?? "", /not an eligible full\/regular track/);
  assert.equal(workshop.pdf_status, "unavailable");

  const portal = enrichCandidate(candidate({ title: "Portal result", venue: "ACL Anthology" }));
  assert.equal(portal.ccf_rank, "unknown");
  assert.equal(portal.track_status, "unknown");

  const demo = enrichCandidate(candidate({ title: "Agent Benchmark Demonstration", venue: "NeurIPS" }));
  assert.equal(demo.track_status, "demo");

  const short = enrichCandidate(candidate({ title: "Agent Benchmark Short Paper", venue: "ACL" }));
  assert.equal(short.track_status, "short_paper");
});

test("literature search keeps preliminary mode until eight CCF-A main-track papers qualify", async () => {
  const result = await searchLiteratureAsync({
    query: "agent benchmark",
    allowNetwork: true,
    limit: 8,
    sources: ["openalex"],
    idea: "agent benchmark",
    fetchImpl: async () => json({
      results: [
        openAlexWork("main", "Main Agent Benchmark", "NeurIPS"),
        ...Array.from({ length: 7 }, (_, index) => openAlexWork(`workshop-${index}`, `Workshop Agent Benchmark ${index + 1}`, "NeurIPS Workshop"))
      ]
    })
  });
  assert.equal(result.candidates.length, 8);
  assert.equal(result.ccf_gate.eligible_core_count, 1);
  assert.equal(result.ccf_gate.preliminary_only, true);
  assert.match(result.warnings.join("\n"), /qualified CCF-A main\/full core papers/);
  assert.match(result.search_report, /Gate/);
  assert.match(result.search_report, /Provenance/);
  assert.match(result.search_report, /Exclusion Reason/);
  assert.equal(result.candidates.filter((item) => item.ccf_gate_status === "included").length, 1);
  assert.equal(result.candidates.filter((item) => item.track_status === "workshop").length, 7);
});

test("venue-aware ranking favors target main-conference candidates over workshops", () => {
  const ranked = rankCandidates([
    candidate({
      title: "Agent Benchmark Evaluation",
      venue: "NeurIPS Workshop",
      abstract: "Agent benchmark evaluation",
      pdf_urls: ["https://example.org/workshop.pdf"],
      year: 2026
    }),
    candidate({
      title: "Agent Benchmark Evaluation",
      venue: "NeurIPS",
      abstract: "Agent benchmark evaluation",
      pdf_urls: ["https://example.org/main.pdf"],
      year: 2022
    })
  ], "agent benchmark evaluation", { targetVenues: ["NeurIPS"] });
  assert.equal(ranked[0]?.track_status, "main_conference");
  assert.ok((ranked[0]?.relevance_score ?? 0) > (ranked[1]?.relevance_score ?? 0));
});

test("ACL Anthology adapter only promotes derived main conference tracks", async () => {
  const result = await searchLiteratureAsync({
    query: "agent benchmark",
    allowNetwork: true,
    limit: 5,
    sources: ["acl-anthology"],
    idea: "agent benchmark",
    fetchImpl: async () => new Response(`
      <a href="/2026.acl-long.1/">Main ACL Agent Benchmark</a>
      <a href="/2026.findings-acl.2/">Findings Agent Benchmark</a>
      <a href="/2026.wmt-1.3/">Workshop Agent Benchmark</a>
      <a href="/2026.acl-demo.4/">Demo Agent Benchmark</a>
      <a href="/2026.acl-srw.5/">SRW Agent Benchmark</a>
    `, { status: 200, headers: { "content-type": "text/html" } })
  });
  const main = result.candidates.find((item) => item.title.includes("Main ACL"));
  const findings = result.candidates.find((item) => item.title.includes("Findings"));
  const workshop = result.candidates.find((item) => item.title.includes("Workshop"));
  const demo = result.candidates.find((item) => item.title.includes("Demo"));
  const srw = result.candidates.find((item) => item.title.includes("SRW"));
  assert.equal(main?.venue, "ACL");
  assert.equal(main?.track_status, "main_conference");
  assert.equal(main?.ccf_rank, "A");
  assert.equal(findings?.ccf_rank, "unknown");
  assert.equal(findings?.track_status, "short_paper");
  assert.equal(workshop?.ccf_rank, "unknown");
  assert.equal(workshop?.track_status, "workshop");
  assert.equal(demo?.ccf_rank, "unknown");
  assert.equal(demo?.track_status, "unknown");
  assert.equal(srw?.ccf_rank, "unknown");
  assert.equal(srw?.track_status, "workshop");
});

test("literature search propagates cancellation from adapter fetches", async () => {
  const controller = new AbortController();
  let sawSignal = false;
  await assert.rejects(
    searchLiteratureAsync({
      queries: ["agent benchmark"],
      allowNetwork: true,
      limit: 5,
      sources: ["openalex"],
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        sawSignal = init?.signal instanceof AbortSignal;
        controller.abort("literature cancelled");
        throw new Error("fetch failed after cancellation");
      }
    }),
    /literature cancelled/
  );
  assert.equal(sawSignal, true);
});

test("literature search rejects if cancellation happens during successful body reads", async () => {
  const controller = new AbortController();
  await assert.rejects(
    searchLiteratureAsync({
      queries: ["agent benchmark"],
      allowNetwork: true,
      limit: 5,
      sources: ["openalex"],
      signal: controller.signal,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          controller.abort("literature body cancelled");
          return {
            results: [{
              id: "https://openalex.org/W1",
              title: "Agent Benchmark",
              publication_year: 2026,
              authorships: [],
              primary_location: { landing_page_url: "https://example.org/paper", pdf_url: "https://example.org/paper.pdf" },
              cited_by_count: 5
            }]
          };
        },
        text: async () => ""
      }) as unknown as Response
    }),
    /literature body cancelled/
  );
});

test("legacy searchLiterature returns deterministic staged search tasks", () => {
  const [records, tasks] = searchLiterature("agent benchmark", { allowNetwork: true });
  assert.deepEqual(records, []);
  assert.match(tasks.join("\n"), /adapter-backed literature search/);
  assert.match(tasks.join("\n"), /baseline dataset metric/);
  assert.doesNotMatch(tasks.join("\n"), /Use searchLiteratureAsync/);
});

test("literature source validation rejects unknown adapters", () => {
  assert.throws(() => normalizeSources(["openalex", "unknown" as never]), /unknown literature source/);
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function openAlexWork(id: string, title: string, venue: string): Record<string, unknown> {
  return {
    id: `https://openalex.org/${id}`,
    title,
    publication_year: 2026,
    authorships: [{ author: { display_name: "Ada Lovelace" } }],
    primary_location: { source: { display_name: venue }, landing_page_url: `https://openalex.org/${id}`, pdf_url: `https://example.org/${id}.pdf` },
    open_access: { oa_url: `https://example.org/${id}.pdf` }
  };
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
