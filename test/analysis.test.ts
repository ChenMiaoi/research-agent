import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { evidenceRowsMarkdown, extractEvidenceRows } from "../src/skills/analysis/evidence-extract.js";
import { relatedWorkMatrixCsv } from "../src/skills/analysis/related-work-matrix.js";
import { buildRelatedWorkSurvey } from "../src/skills/analysis/survey.js";
import { assessNovelty, noveltyMatrixMarkdown } from "../src/skills/analysis/novelty-matrix.js";
import { buildIdeaVsPriorWork } from "../src/skills/analysis/idea-vs-prior.js";
import { strictCcfAScore, strictScoreMarkdown } from "../src/skills/analysis/ccf-a-score.js";
import { sha256 } from "../src/skills/pdf/provenance.js";

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
  assert.deepEqual(novelty.dimension_deltas.map((delta) => delta.dimension), ["problem", "method", "data", "metric", "evaluation", "contribution"]);
  assert.ok(novelty.dimension_deltas.some((delta) => delta.dimension === "data" && delta.risk === "high"));
});

test("novelty assessment is blocked without verified evidence refs", () => {
  const novelty = assessNovelty("agent benchmark evaluation metric dataset", [candidate("Agent benchmark evaluation metric dataset")]);
  assert.equal(novelty.collision_risk, "low");
  assert.match(novelty.reasons[0] ?? "", /blocked/);
  assert.equal(novelty.dimension_deltas.every((delta) => delta.status === "blocked"), true);
});

test("novelty matrix reports dimension-level idea-vs-prior-work deltas", () => {
  const novelty = assessNovelty("causal intervention method for agent evaluation with a new benchmark metric", [
    candidate("Agent evaluation benchmark metric framework")
  ], [
    evidence("agent-evaluation-benchmark-metric-framework", "This benchmark framework reports evaluation metrics and baseline comparisons for agent methods.")
  ]);
  const data = novelty.dimension_deltas.find((delta) => delta.dimension === "data");
  const evaluation = novelty.dimension_deltas.find((delta) => delta.dimension === "evaluation");
  const contribution = novelty.dimension_deltas.find((delta) => delta.dimension === "contribution");
  assert.equal(data?.status, "weak");
  assert.equal(evaluation?.risk, "high");
  assert.equal(contribution?.status, "missing");
  const markdown = noveltyMatrixMarkdown(novelty);
  assert.match(markdown, /Dimension Delta Matrix/);
  assert.match(markdown, /\| Data \| weak \| high \| benchmark \|/);
  assert.match(markdown, /Side-by-side contrast/);
});

test("novelty matrix ignores unverified rows and keeps missing dimensions out of collision risk", () => {
  const rows = [
    evidence("paper-a", "verified method evidence"),
    {
      ...evidence("paper-a", "agent benchmark evaluation metric dataset collision"),
      status: "planned" as const,
      page: undefined,
      quote: undefined,
      chunk_id: undefined
    }
  ];
  const novelty = assessNovelty("agent benchmark evaluation metric dataset", [candidate("Paper A")], rows);
  assert.equal(novelty.collision_risk, "low");
  assert.equal(novelty.dimension_deltas.find((delta) => delta.dimension === "problem")?.status, "missing");
  assert.equal(novelty.dimension_deltas.find((delta) => delta.dimension === "problem")?.risk, "unknown");
});

test("paper notes and related-work signals are derived from evidence text", () => {
  const rows = [evidence("paper1", "This benchmark problem evaluates a method baseline on a dataset with metric evidence and a limitation.")];
  const notes = evidenceRowsMarkdown(rows);
  assert.match(notes["docs/reference/paper_notes/paper1.md"] ?? "", /evidence_status = verified/);
  assert.match(notes["docs/reference/paper_notes/paper1.md"] ?? "", /Problem evidence/);
  assert.match(notes["docs/reference/paper_notes/paper1.md"] ?? "", /Method evidence/);
  assert.match(notes["docs/reference/paper_notes/paper1.md"] ?? "", /chunk_id: p1-c1/);
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

test("survey and idea-vs-prior use only verified note-backed evidence", () => {
  const rows = [
    evidence("paper1", "Agent benchmark method uses a baseline on a dataset with an accuracy metric."),
    {
      ...evidence("paper2", "Metadata-only baseline dataset metric should be ignored."),
      paper_id: "paper2"
    }
  ];
  const candidates = [
    {
      candidate_id: "paper1",
      title: "Verified Agent Benchmark",
      authors: [],
      year: 2026,
      source_urls: [],
      pdf_urls: [],
      retrieval_sources: [],
      retrieval_queries: [],
      confidence: "high" as const
    },
    {
      candidate_id: "paper2",
      title: "Metadata Only Benchmark",
      authors: [],
      year: 2026,
      source_urls: [],
      pdf_urls: [],
      retrieval_sources: [],
      retrieval_queries: [],
      confidence: "high" as const
    }
  ];
  const noteArtifacts = {
    "docs/reference/paper_notes/paper1.md": "evidence_status = verified\n",
    "docs/reference/paper_notes/paper2.md": "evidence_status = unverified\n"
  };
  const survey = buildRelatedWorkSurvey({
    ideaBrief: sampleIdeaBrief(),
    searchPlan: sampleSearchPlan(),
    candidates,
    evidenceRows: rows,
    noteArtifacts
  });
  assert.match(survey.markdown, /Related Work Survey/);
  assert.match(survey.markdown, /Verified Agent Benchmark/);
  assert.doesNotMatch(survey.markdown, /Metadata Only Benchmark/);
  assert.equal(survey.reviewerExpectedBaselines.length, 1);
  assert.equal(survey.reviewerExpectedDatasets.length, 1);
  assert.equal(survey.reviewerExpectedMetrics.length, 1);
  const agentOnlySignals = buildRelatedWorkSurvey({
    ideaBrief: sampleIdeaBrief(),
    searchPlan: sampleSearchPlan(),
    candidates: [candidates[0]!],
    evidenceRows: [evidence("paper1", "This paper describes agent evaluation without scoring keywords.")],
    noteArtifacts: {
      "docs/reference/paper_notes/paper1.md": "evidence_status = verified\n"
    },
    agentRelatedWork: {
      reviewer_expected_baselines: ["Agent-proposed baseline must not count"],
      evaluation_conventions: ["Agent-proposed metric must not count"]
    } as any
  });
  assert.deepEqual(agentOnlySignals.reviewerExpectedBaselines, []);
  assert.deepEqual(agentOnlySignals.reviewerExpectedMetrics, []);
  const metadataOnlySurvey = buildRelatedWorkSurvey({
    ideaBrief: sampleIdeaBrief(),
    searchPlan: sampleSearchPlan(),
    candidates,
    evidenceRows: [rows[1]!],
    noteArtifacts: {
      "docs/reference/paper_notes/paper2.md": "evidence_status = unverified\n"
    }
  });
  assert.equal(metadataOnlySurvey.verifiedPaperCount, 0);
  assert.doesNotMatch(metadataOnlySurvey.markdown, /Metadata Only Benchmark/);

  const novelty = assessNovelty("agent benchmark baseline dataset accuracy metric", [candidates[0]!], [rows[0]!]);
  const ideaVsPrior = buildIdeaVsPriorWork({
    idea: "agent benchmark baseline dataset accuracy metric",
    candidates,
    evidenceRows: rows,
    novelty,
    noteArtifacts
  });
  assert.match(ideaVsPrior.markdown, /Idea vs Prior Work/);
  assert.match(ideaVsPrior.markdown, /Verified Agent Benchmark/);
  assert.doesNotMatch(ideaVsPrior.markdown, /Metadata Only Benchmark/);
  assert.equal(ideaVsPrior.collisionRisk, "high");
  const metadataOnlyPrior = buildIdeaVsPriorWork({
    idea: "agent benchmark baseline dataset accuracy metric",
    candidates,
    evidenceRows: [rows[1]!],
    novelty,
    noteArtifacts: {
      "docs/reference/paper_notes/paper2.md": "evidence_status = unverified\n"
    }
  });
  assert.equal(metadataOnlyPrior.rows.length, 0);
  assert.doesNotMatch(metadataOnlyPrior.markdown, /Metadata Only Benchmark/);
});

test("strict CCF-A score applies all evidence cap rules", () => {
  const cases: Array<[string, Parameters<typeof strictCcfAScore>[0], number, string]> = [
    ["No verified related work", { pdfReadCount: 1, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true }, 45, "No verified related work"],
    ["No PDF read", { verifiedRelatedWorkCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true }, 45, "No PDF read"],
    ["CCF-A venue gate blocked", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, ccfAGateBlocked: true, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true }, 55, "CCF-A venue gate blocked"],
    ["No CCF-A core papers", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 0, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true }, 55, "No CCF-A core papers"],
    ["No baseline/dataset/metric", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasExecutableExperimentPlan: true }, 60, "No baseline/dataset/metric"],
    ["High prior-work collision", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, highPriorWorkCollision: true }, 40, "High prior-work collision"],
    ["Engineering artifact without research question", { verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, pureEngineeringIntegration: true }, 50, "Engineering artifact without research question"],
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
    assert.ok(score.hard_blockers.includes(reason));
  }
  assert.equal(strictCcfAScore({ verifiedRelatedWorkCount: 0, pdfReadCount: 0, corePaperCount: 5 }).score_type, "Preliminary");
  assert.equal(strictCcfAScore({ verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, ccfAGateBlocked: true }).score_type, "Preliminary");
  assert.equal(strictCcfAScore({ verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, hasStrongBaseline: true, hasDatasetOrBenchmark: false, hasMetric: true, hasExecutableExperimentPlan: true }).score_type, "Evidence-backed");
  assert.equal(strictCcfAScore({ verifiedRelatedWorkCount: 5, pdfReadCount: 5, corePaperCount: 5, evidenceRefs: ["e1", "e2"], hasStrongBaseline: true, hasDatasetOrBenchmark: true, hasMetric: true, hasExecutableExperimentPlan: true, hasScientificHypothesis: true }).score_type, "Submission-ready");
});

test("strict CCF-A score reports evidence-backed dimensions and target paths", () => {
  const score = strictCcfAScore({
    verifiedRelatedWorkCount: 2,
    pdfReadCount: 1,
    corePaperCount: 2,
    evidenceRefs: ["e1", "e2"],
    hasStrongBaseline: true,
    hasDatasetOrBenchmark: false,
    hasMetric: true,
    hasExecutableExperimentPlan: false,
    highPriorWorkCollision: false,
    hasScientificHypothesis: true,
    venueRequiresThreatModel: true,
    hasThreatModel: false
  });

  assert.equal(score.score_dimensions.length, 8);
  assert.equal(score.score_dimensions.reduce((sum, dimension) => sum + dimension.maxScore, 0), 100);
  assert.deepEqual(score.score_dimensions.map((dimension) => `${dimension.name}:${dimension.maxScore}`), [
    "Problem Significance:10",
    "Novelty:20",
    "Technical Depth:15",
    "Method Clarity:10",
    "Experimental Rigor:20",
    "Related Work:10",
    "Feasibility / Reproducibility:10",
    "Venue / Story:5"
  ]);
  assert.ok(Object.hasOwn(score.dimensions, "problem_significance"));
  assert.ok(Object.hasOwn(score.dimensions, "experimental_rigor"));
  assert.ok(Object.hasOwn(score.dimensions, "venue_story"));
  assert.equal(score.score_type, "Evidence-backed");
  assert.ok(score.confidence > 0 && score.confidence <= 0.9);
  assert.ok(score.hard_blockers.includes("No baseline/dataset/metric"));
  assert.ok(score.why_not_ccf_a.some((reason) => /No baseline\/dataset\/metric|not yet submission-ready/i.test(reason)));
  assert.ok(score.soft_weaknesses.length > 0);
  assert.ok(score.path_to_70.some((action) => /dataset|benchmark|experiment|related/i.test(action)));
  assert.ok(score.path_to_80.some((action) => /ablations|provenance|related|dataset|experiment/i.test(action)));
  const evaluation = score.score_dimensions.find((dimension) => dimension.name === "Experimental Rigor");
  assert.ok(evaluation);
  assert.deepEqual(evaluation.positiveEvidence, ["e1", "e2"]);
  assert.ok(evaluation.missingEvidence.includes("Concrete dataset or benchmark"));
  assert.ok(evaluation.recommendedActions.length > 0);
  assert.equal(score.score_dimensions.flatMap((dimension) => dimension.positiveEvidence).every((ref) => /^e\d+$/.test(ref)), true);
  assert.equal(score.score_dimensions.flatMap((dimension) => dimension.negativeEvidence).length, 0);
  const markdown = strictScoreMarkdown(score);
  assert.match(markdown, /Score type: Evidence-backed/);
  assert.match(markdown, /## Active Caps/);
  assert.match(markdown, /Strict Rubric/);
  assert.match(markdown, /\| Dimension \| Score \| Confidence \| Evidence \| Missing \| Rationale \|/);
  assert.match(markdown, /## Why not CCF-A/);
  assert.match(markdown, /## Path to 70/);
  assert.match(markdown, /## Path to 80/);
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
    assert.match(scorecard, /Score type: Preliminary/);
    assert.match(scorecard, /Strict Rubric/);
    assert.match(scorecard, /Path to 70/);
    assert.match(scorecard, /No verified related work/);
    assert.match(await readFile(join(output, "docs/proposal/revised_idea.md"), "utf8"), /Revised Idea/);
    assert.match(await readFile(join(output, "docs/relative_work/novelty_gap_matrix.md"), "utf8"), /Novelty Gap Matrix/);
    const survey = await readFile(join(output, "docs/relative_work/survey.md"), "utf8");
    assert.match(survey, /Related Work Survey/);
    assert.doesNotMatch(survey, /^\s*\{/m);
    const ideaVsPrior = await readFile(join(output, "docs/relative_work/idea_vs_prior_work.md"), "utf8");
    assert.match(ideaVsPrior, /Idea vs Prior Work/);
    assert.doesNotMatch(ideaVsPrior, /^\s*\{/m);
    assert.match(await readFile(join(output, "docs/relative_work/related_work_matrix.csv"), "utf8"), /evidence_page,evidence_quote,evidence_chunk_id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("papers analyze ignores fabricated chunks without PDF provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-analysis-stale-chunks-"));
  const output = join(root, "project");
  try {
    await writeArtifact(output, "docs/reference/pdf_chunks.json", JSON.stringify([
      {
        paper_id: "paper-1",
        chunk_id: "p1-c1",
        page: 1,
        text: "fabricated baseline dataset metric evidence"
      }
    ], null, 2) + "\n");
    assert.equal(await main(["papers", "analyze", "--output", output]), 0);
    assert.deepEqual(JSON.parse(await readFile(join(output, "docs/reference/pdf_chunks.json"), "utf8")), []);
    assert.doesNotMatch(await readFile(join(output, "docs/reference/claim_evidence_matrix.csv"), "utf8"), /fabricated/);
    assert.equal(await main(["score", "--output", output, "--strict-ccf-a"]), 0);
    assert.match(await readFile(join(output, "docs/diagnosis/ccf_a_strict_scorecard.md"), "utf8"), /No verified related work/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("papers analyze creates metadata-only notes for candidates without PDFs", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-analysis-metadata-notes-"));
  const output = join(root, "project");
  try {
    await writeArtifact(output, "docs/relative_work/candidates.json", JSON.stringify([
      {
        candidate_id: "metadata-only-paper",
        title: "Metadata Only Agent Benchmark",
        authors: ["Ada Lovelace"],
        year: 2026,
        venue: "NeurIPS",
        source_urls: ["https://example.org/metadata-only-paper"],
        pdf_urls: [],
        retrieval_sources: ["test"],
        retrieval_queries: ["agent benchmark"],
        confidence: "high",
        ccf_rank: "A",
        track_status: "main_conference"
      }
    ], null, 2) + "\n");
    assert.equal(await main(["papers", "analyze", "--output", output]), 0);
    const note = await readFile(join(output, "docs/reference/paper_notes/metadata-only-paper.md"), "utf8");
    assert.match(note, /evidence_status = unverified/);
    assert.match(note, /Metadata-only note/);
    assert.match(note, /chunk_id: missing/);
    assert.doesNotMatch(await readFile(join(output, "docs/reference/claim_evidence_matrix.csv"), "utf8"), /Metadata Only Agent Benchmark/);
    assert.doesNotMatch(await readFile(join(output, "docs/relative_work/related_work_matrix.csv"), "utf8"), /Metadata Only Agent Benchmark/);
    assert.doesNotMatch(await readFile(join(output, "docs/relative_work/survey.md"), "utf8"), /Metadata Only Agent Benchmark/);
    assert.doesNotMatch(await readFile(join(output, "docs/relative_work/idea_vs_prior_work.md"), "utf8"), /Metadata Only Agent Benchmark/);
    assert.equal(await main(["score", "--output", output, "--strict-ccf-a"]), 0);
    assert.match(await readFile(join(output, "docs/diagnosis/ccf_a_strict_scorecard.md"), "utf8"), /No verified related work/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("papers analyze rejects downloaded manifest records missing pdf path", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-analysis-invalid-manifest-"));
  const output = join(root, "project");
  try {
    await writeArtifact(output, "docs/relative_work/candidates.json", JSON.stringify([
      {
        candidate_id: "paper-1",
        title: "Agent Benchmark Evaluation",
        authors: ["Ada Lovelace"],
        year: 2026,
        source_urls: ["https://example.org/paper"],
        pdf_urls: [],
        retrieval_sources: ["test"],
        retrieval_queries: ["agent benchmark"],
        confidence: "high"
      }
    ], null, 2) + "\n");
    await writeArtifact(output, "docs/reference/pdf_manifest.json", JSON.stringify([
      {
        paper_id: "paper-1",
        pdf_sha256: "abc",
        source_url: "https://arxiv.org/pdf/1234.56789",
        downloaded_at: "2026-05-11T00:00:00Z",
        bytes: 123,
        license_hint: "arXiv",
        title_match_score: 1,
        status: "downloaded"
      }
    ], null, 2) + "\n");
    await writeArtifact(output, "docs/reference/pdf_chunks.json", JSON.stringify([
      {
        paper_id: "paper-1",
        chunk_id: "p1-c1",
        page: 1,
        text: "fabricated baseline dataset metric evidence"
      }
    ], null, 2) + "\n");
    assert.equal(await main(["papers", "analyze", "--output", output]), 0);
    assert.deepEqual(JSON.parse(await readFile(join(output, "docs/reference/pdf_chunks.json"), "utf8")), []);
    assert.doesNotMatch(await readFile(join(output, "docs/reference/claim_evidence_matrix.csv"), "utf8"), /fabricated/);
    assert.doesNotMatch(await readFile(join(output, "docs/relative_work/related_work_matrix.csv"), "utf8"), /downloaded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("papers analyze rejects low-title-match downloaded manifest records", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-analysis-low-title-match-"));
  const output = join(root, "project");
  try {
    const pdf = Buffer.from("%PDF-1.4\n/Type /Page\nstream\nfabricated baseline dataset metric evidence\nendstream\n%%EOF\n", "latin1");
    await writeBinaryArtifact(output, "docs/reference/pdfs/paper-1.pdf", pdf);
    await writeArtifact(output, "docs/relative_work/candidates.json", JSON.stringify([
      {
        candidate_id: "paper-1",
        title: "Agent Benchmark Evaluation",
        authors: ["Ada Lovelace"],
        year: 2026,
        source_urls: ["https://example.org/paper"],
        pdf_urls: [],
        retrieval_sources: ["test"],
        retrieval_queries: ["agent benchmark"],
        confidence: "high"
      }
    ], null, 2) + "\n");
    await writeArtifact(output, "docs/reference/pdf_manifest.json", JSON.stringify([
      {
        paper_id: "paper-1",
        pdf_path: "docs/reference/pdfs/paper-1.pdf",
        pdf_sha256: sha256(pdf),
        source_url: "https://arxiv.org/pdf/1234.56789",
        downloaded_at: "2026-05-11T00:00:00Z",
        bytes: pdf.byteLength,
        license_hint: "arXiv",
        title_match_score: 0,
        status: "downloaded"
      }
    ], null, 2) + "\n");
    assert.equal(await main(["papers", "analyze", "--output", output]), 0);
    assert.deepEqual(JSON.parse(await readFile(join(output, "docs/reference/pdf_chunks.json"), "utf8")), []);
    assert.doesNotMatch(await readFile(join(output, "docs/relative_work/related_work_matrix.csv"), "utf8"), /downloaded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeArtifact(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeBinaryArtifact(root: string, relativePath: string, content: Buffer): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

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
    claim_type: "method" as const,
    required_evidence: "page quote chunk",
    planned_artifact: "note",
    status: "verified" as const,
    page: "1",
    section: "unknown",
    quote,
    chunk_id: "p1-c1",
    confidence: 0.6
  };
}

function sampleIdeaBrief() {
  return {
    idea_summary: "Build an LLM agent benchmark.",
    problem: "agent evaluation",
    target_domain: "AI / LLM Agent",
    target_venues: ["NeurIPS"],
    method_keywords: ["agent"],
    task_keywords: ["benchmark"],
    evaluation_keywords: ["baseline", "dataset", "metric"],
    resource_constraints: ["single researcher"],
    missing_information: [],
    assumptions: ["test"],
    search_seed_terms: ["agent", "benchmark"]
  };
}

function sampleSearchPlan() {
  const query = (value: string) => ({ query: value, source_hints: ["openalex"], purpose: "test" });
  return {
    core_concepts: ["agent", "benchmark"],
    synonyms: ["agent evaluation"],
    precision_queries: [query("agent benchmark precision")],
    recall_queries: [query("agent benchmark recall")],
    baseline_queries: [query("baseline")],
    dataset_metric_queries: [query("dataset metric")],
    venue_queries: [query("NeurIPS agent benchmark")],
    collision_queries: [query("agent benchmark prior work")],
    stop_condition: "enough candidates"
  };
}
