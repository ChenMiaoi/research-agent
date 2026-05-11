import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { evidenceRowsMarkdown, extractEvidenceRows } from "../src/skills/analysis/evidence-extract.js";
import { relatedWorkMatrixCsv } from "../src/skills/analysis/related-work-matrix.js";
import { assessNovelty } from "../src/skills/analysis/novelty-matrix.js";
import { strictCcfAScore } from "../src/skills/analysis/ccf-a-score.js";

test("evidence extraction requires page quote and chunk id", () => {
  const rows = extractEvidenceRows([{ paper_id: "paper1", page: 2, chunk_id: "p2-c1", text: "This paper reports a useful benchmark result with limitations." }]);
  assert.equal(rows[0]?.status, "verified");
  assert.equal(rows[0]?.page, "2");
  assert.equal(rows[0]?.chunk_id, "p2-c1");
  assert.match(rows[0]?.quote ?? "", /benchmark/);
});

test("novelty assessment marks repeated overlap as high collision", () => {
  const novelty = assessNovelty("agent benchmark evaluation metric dataset", [
    candidate("Agent benchmark evaluation metric dataset"),
    candidate("Agent benchmark dataset evaluation"),
    candidate("Evaluation metric benchmark for agents")
  ], [
    evidence("agent-benchmark-evaluation-metric-dataset", "agent benchmark evaluation metric dataset"),
    evidence("agent-benchmark-dataset-evaluation", "agent benchmark dataset evaluation"),
    evidence("evaluation-metric-benchmark-for-agents", "evaluation metric benchmark for agents")
  ]);
  assert.equal(novelty.collision_risk, "high");
  assert.equal(novelty.novelty_cap, 6);
  assert.equal(novelty.total_cap, 55);
});

test("novelty assessment is blocked without verified evidence refs", () => {
  const novelty = assessNovelty("agent benchmark evaluation metric dataset", [candidate("Agent benchmark evaluation metric dataset")]);
  assert.equal(novelty.collision_risk, "low");
  assert.match(novelty.reasons[0] ?? "", /blocked/);
});

test("paper notes and related-work signals are derived from evidence text", () => {
  const rows = [evidence("paper1", "This benchmark problem evaluates a method baseline on a dataset with metric evidence and a limitation.")];
  const notes = evidenceRowsMarkdown(rows);
  assert.match(notes["docs/reference/paper_notes/paper1.md"] ?? "", /Problem evidence/);
  assert.match(notes["docs/reference/paper_notes/paper1.md"] ?? "", /Method evidence/);
  assert.doesNotMatch(notes["docs/reference/paper_notes/paper1.md"] ?? "", /TODO/);
  const matrix = relatedWorkMatrixCsv(
    [
      {
        candidate_id: "paper1",
        title: "Metadata title with no signal",
        authors: [],
        year: 2026,
        source_urls: [],
        pdf_urls: [],
        retrieval_sources: [],
        retrieval_queries: [],
        confidence: "high"
      },
      {
        candidate_id: "paper2",
        title: "Metadata baseline dataset metric benchmark",
        authors: [],
        year: 2026,
        source_urls: [],
        pdf_urls: [],
        retrieval_sources: [],
        retrieval_queries: [],
        confidence: "high"
      }
    ],
    [],
    rows
  );
  assert.match(matrix, /evidence_page,evidence_quote,evidence_chunk_id/);
  assert.match(matrix, /paper1,.*yes,yes,yes/);
  assert.match(matrix, /paper2,.*no,no,no/);
});

test("strict CCF-A score applies all evidence cap rules", () => {
  const cases: Array<[string, Parameters<typeof strictCcfAScore>[0], number, string]> = [
    ["No verified related work", { pdfReadCount: 1, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true }, 50, "No verified related work"],
    ["No PDF read", { verifiedRelatedWorkCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true }, 45, "No PDF read"],
    ["Fewer than 5 core related papers", { verifiedRelatedWorkCount: 4, pdfReadCount: 4, corePaperCount: 4, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true }, 60, "Fewer than 5 core related papers"],
    ["No strong baseline", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true }, 65, "No strong baseline"],
    ["No dataset/benchmark", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasMetric: true, hasExecutableExperimentPlan: true }, 60, "No dataset/benchmark"],
    ["No metric", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasExecutableExperimentPlan: true }, 60, "No metric"],
    ["High prior-work collision", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, highPriorWorkCollision: true }, 55, "High prior-work collision"],
    ["Pure engineering integration without scientific hypothesis", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, pureEngineeringIntegration: true }, 55, "Pure engineering integration without scientific hypothesis"],
    ["No executable experiment plan", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true }, 65, "No executable experiment plan"],
    ["Single-person/12-week plan is clearly infeasible", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, singlePersonTwelveWeekInfeasible: true }, 70, "Single-person/12-week plan is clearly infeasible"],
    ["Target venue requires threat model but none exists", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, venueRequiresThreatModel: true }, 65, "Target venue requires threat model but none exists"],
    ["Target venue requires system evaluation but prototype absent", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, venueRequiresSystemEvaluation: true }, 60, "Target venue requires system evaluation but prototype absent"],
    ["Target venue expects strong ML baselines but none defined", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, venueExpectsStrongMlBaselines: true }, 65, "Target venue expects strong ML baselines but none defined"]
  ];
  for (const [, input, cap, reason] of cases) {
    const score = strictCcfAScore(input);
    assert.ok(score.total <= cap, `${reason} should cap total at ${cap}`);
    assert.ok(score.caps.some((item) => item.reason === reason));
  }
});

test("papers analyze score and refine CLI write analysis artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-analysis-"));
  const output = join(root, "project");
  try {
    assert.equal(await main(["research", "Agent benchmark with baseline dataset metric experiment hypothesis", "--output", output, "--offline"]), 0);
    assert.equal(await main(["literature", "plan", "Agent benchmark with baseline dataset metric", "--output", output]), 0);
    assert.equal(await main(["literature", "search", "--output", output, "--query", "agent benchmark baseline dataset metric"]), 0);
    assert.equal(await main(["literature", "download", "--output", output]), 0);
    assert.equal(await main(["papers", "analyze", "--output", output]), 0);
    assert.equal(await main(["score", "--output", output, "--strict-ccf-a", "--venue", "NeurIPS"]), 0);
    assert.equal(await main(["refine", "--output", output, "--resource", "single researcher"]), 0);
    const scorecard = await readFile(join(output, "docs/diagnosis/ccf_a_strict_scorecard.md"), "utf8");
    assert.match(scorecard, /CCF-A Strict Scorecard/);
    assert.match(scorecard, /No verified related work/);
    assert.match(await readFile(join(output, "docs/proposal/revised_idea.md"), "utf8"), /Revised Idea/);
    assert.match(await readFile(join(output, "docs/relative_work/novelty_gap_matrix.md"), "utf8"), /Novelty Gap Matrix/);
    assert.match(await readFile(join(output, "docs/relative_work/related_work_matrix.csv"), "utf8"), /evidence_page,evidence_quote,evidence_chunk_id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function candidate(title: string) {
  return {
    candidate_id: title.toLowerCase().replace(/\s+/g, "-"),
    title,
    authors: ["Ada Lovelace"],
    year: 2026,
    source_urls: ["https://example.org/paper"],
    pdf_urls: [],
    retrieval_sources: ["test"],
    retrieval_queries: ["agent benchmark"],
    confidence: "high" as const
  };
}

function evidence(paperId: string, quote = "verified quote") {
  return {
    paper_id: paperId,
    claim: "claim",
    required_evidence: "page quote chunk",
    planned_artifact: "note",
    status: "verified" as const,
    page: "1",
    quote,
    chunk_id: "p1-c1"
  };
}
