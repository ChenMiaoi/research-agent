import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createResearchPipelineState, markStage, writeResearchPipelineState } from "../src/pipeline/stage-state.js";
import { runResearchPipeline } from "../src/pipeline/research-pipeline.js";
import { readDecisionRecords } from "../src/runtime/decisions.js";
import { JsonlEventSink, readJsonlEvents } from "../src/runtime/events.js";
import { readToolCallRecords } from "../src/runtime/tools.js";
import { evidenceRowsMarkdown, extractEvidenceRows, trustedEvidenceRows, type ClaimEvidenceRow } from "../src/skills/analysis/evidence-extract.js";
import { assessNovelty, noveltyMatrixMarkdown } from "../src/skills/analysis/novelty-matrix.js";
import { relatedWorkMatrixCsv } from "../src/skills/analysis/related-work-matrix.js";
import { strictCcfAScore } from "../src/skills/analysis/ccf-a-score.js";
import { enrichCandidate, resolveVenue } from "../src/skills/literature/venue.js";
import type { PaperCandidate } from "../src/skills/literature/types.js";
import { buildPdfChunkIndex, type PdfChunkIndexEntry } from "../src/skills/pdf/chunk.js";
import type { PdfManifestRecord } from "../src/skills/pdf/provenance.js";

test("eval: known idea with known papers yields evidence-backed matrices", () => {
  const idea = "Build a literature-grounded research agent benchmark with dataset, metric, baseline, and ablation evidence.";
  const candidates = [
    knownCandidate({
      candidate_id: "agent-benchmark-evaluation",
      title: "Agent Benchmark Evaluation",
      venue: "NeurIPS",
      abstract: "Agent benchmark evaluation with datasets, metrics, baselines, and ablations.",
      pdf_urls: ["https://arxiv.org/pdf/2601.00001"]
    }),
    knownCandidate({
      candidate_id: "literature-grounded-research-agents",
      title: "Literature Grounded Research Agents",
      venue: "ICML",
      abstract: "Research agents that compare prior work and generate evaluation reports.",
      pdf_urls: ["https://openreview.net/pdf?id=known"]
    })
  ].map((candidate) => enrichCandidate(candidate, { idea, targetVenues: ["NeurIPS", "ICML"] }));
  const rows = [
    evidenceRow("agent-benchmark-evaluation", "baseline", "2", "p2-c1", "The evaluation uses a dataset benchmark, baseline comparison, metric, result table, and ablation study."),
    evidenceRow("literature-grounded-research-agents", "method", "5", "p5-c1", "The method compares prior work with a literature-grounded agent and reports reviewer-facing evidence.")
  ];
  const manifest: PdfManifestRecord[] = candidates.map((candidate) => ({
    paper_id: safePaperId(candidate.candidate_id),
    status: "downloaded",
    pdf_path: `docs/reference/pdfs/${safePaperId(candidate.candidate_id)}.pdf`,
    pdf_sha256: "0".repeat(64),
    source_url: candidate.pdf_urls[0],
    license_hint: "arXiv",
    bytes: 1024
  }));

  const related = relatedWorkMatrixCsv(candidates, manifest, rows);
  assert.match(related, /Agent Benchmark Evaluation/);
  assert.match(related, /evidence_page,evidence_quote,evidence_chunk_id/);
  assert.match(related, /baseline_signal,dataset_signal,metric_signal/);
  assert.match(related, /p2-c1/);

  const novelty = assessNovelty(idea, candidates, rows);
  const noveltyReport = noveltyMatrixMarkdown(novelty);
  assert.equal(novelty.dimension_deltas.map((delta) => delta.dimension).join(","), "problem,method,data,metric,evaluation,contribution");
  assert.ok(novelty.evidence_refs.length > 0);
  assert.match(noveltyReport, /Dimension Delta Matrix/);
  assert.match(noveltyReport, /page 2, chunk p2-c1/);

  const score = strictCcfAScore({
    verifiedRelatedWorkCount: 2,
    pdfReadCount: 2,
    corePaperCount: 2,
    evidenceRefs: ["eval-e1", "eval-e2"],
    hasStrongBaseline: true,
    hasDatasetOrBenchmark: true,
    hasMetric: true,
    hasExecutableExperimentPlan: true,
    hasScientificHypothesis: true
  });
  assert.ok(score.score_dimensions.every((dimension) => dimension.positiveEvidence.every((ref) => /^eval-e\d+$/.test(ref))));
  assert.equal(score.score_type, "Evidence-backed");
  assert.equal(score.hard_blockers.includes("No baseline/dataset/metric"), false);
});

test("eval: plausible fake papers without PDF evidence are not promoted", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-eval-fake-paper-"));
  const idea = "Build a research workflow reviewer that must reject unsupported paper claims.";
  const fake = knownCandidate({
    candidate_id: "agent-benchmark-evaluation-study",
    title: "Agent Benchmark Evaluation Study",
    venue: "NeurIPS",
    authors: ["Jane Example", "Alan Sample"],
    source_urls: ["https://example.org/agent-benchmark-evaluation-study"],
    pdf_urls: ["https://example.org/agent-benchmark-evaluation-study.pdf"],
    abstract: "Agent benchmark evaluation with dataset metrics and baseline claims, but no verified PDF evidence."
  });
  try {
    await mkdir(join(root, "docs", "relative_work"), { recursive: true });
    await writeFile(join(root, "docs", "relative_work", "candidates.json"), JSON.stringify([fake], null, 2) + "\n", "utf8");
    await writeFile(join(root, "docs", "relative_work", "search_report.md"), "# Search Report\n\nOne plausible but unverified candidate.\n", "utf8");
    let state = createResearchPipelineState(idea, root, "2026-05-11T00:00:00Z");
    state = markStage(state, "literature_search", "completed", {
      artifacts: ["docs/relative_work/candidates.json", "docs/relative_work/search_report.md"],
      now: "2026-05-11T00:00:01Z"
    });
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, { outputRoot: root, provider: "offline", runId: "eval-fake-paper" });
    const searchableReports = [
      result.artifacts["papers/papers.bib"],
      result.artifacts["reports/evidence_ledger.md"],
      result.artifacts["reports/related_work.md"],
      result.artifacts["paper/related_work.md"],
      result.artifacts["docs/relative_work/topic_clusters.md"],
      result.artifacts["docs/relative_work/related_work_matrix.csv"],
      result.artifacts["docs/relative_work/triage_report.md"]
    ].join("\n");
    assert.equal(result.verifiedPapers.length, 0);
    assert.match(result.artifacts["papers/papers.bib"] ?? "", /Do not invent paper titles/);
    assert.doesNotMatch(searchableReports, /Agent Benchmark Evaluation Study/);
    assert.match(result.artifacts["docs/diagnosis/ccf_a_strict_scorecard.md"] ?? "", /No verified related work/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eval: resumed triage cannot promote unverified fake papers", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-eval-stale-triage-"));
  const idea = "Build a research workflow reviewer that must reject unsupported paper claims.";
  const verified = knownCandidate({
    candidate_id: "verified-agent-evidence",
    title: "Verified Agent Evidence",
    abstract: "Verified PDF evidence with dataset, baseline, metric, and limitation signals."
  });
  const fake = knownCandidate({
    candidate_id: "fake-agent-benchmark-evaluation-study",
    title: "Fake Agent Benchmark Evaluation Study",
    authors: ["Invented Author"],
    source_urls: ["https://example.org/fake-agent-benchmark"],
    pdf_urls: ["https://example.org/fake-agent-benchmark.pdf"],
    abstract: "Plausible metadata-only benchmark claims with no trusted PDF evidence."
  });
  const fillers = Array.from({ length: 6 }, (_, index) =>
    knownCandidate({
      candidate_id: `metadata-only-filler-${index + 1}`,
      title: `Metadata Only Filler ${index + 1}`,
      pdf_urls: []
    })
  );
  try {
    const chunks = await writeValidPdfProvenance(root, "verified-agent-evidence", "Verified PDF evidence compares a baseline on a dataset with an accuracy metric and a limitation.");
    const candidates = [verified, fake, ...fillers];
    await writeArtifact(root, "docs/relative_work/candidates.json", JSON.stringify(candidates, null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/search_report.md", "# Search Report\n\nMixed verified and unverified candidates.\n");
    await writeArtifact(root, "docs/relative_work/triage_report.md", `# Candidate Triage\n\n- ${fake.title}\n`);
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(chunks, null, 2) + "\n");
    await writeArtifact(root, "docs/reference/paper_notes/README.md", "# Paper Notes\n\nResumed.\n");
    let state = createResearchPipelineState(idea, root, "2026-05-11T00:00:00Z");
    for (const stage of ["literature_search", "candidate_triage", "pdf_acquisition", "pdf_reading"] as const) {
      state = markStage(state, stage, "completed", { now: "2026-05-11T00:00:01Z" });
    }
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, { outputRoot: root, provider: "offline", runId: "eval-stale-triage", strictCcfA: true });
    assert.equal(result.verifiedPapers.length, 1);
    assert.match(result.artifacts["docs/relative_work/triage_report.md"] ?? "", /Verified Agent Evidence/);
    assert.doesNotMatch(result.artifacts["docs/relative_work/triage_report.md"] ?? "", /Fake Agent Benchmark Evaluation Study/);
    assert.doesNotMatch(result.artifacts["docs/relative_work/related_work_matrix.csv"] ?? "", /Fake Agent Benchmark Evaluation Study/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eval: CCF-A venue normalization separates aliases from workshops", () => {
  assert.equal(resolveVenue("Conference on Neural Information Processing Systems")?.canonical, "NeurIPS");
  assert.equal(resolveVenue("NIPS")?.canonical, "NeurIPS");
  assert.equal(resolveVenue("Fake NeurIPS Symposium"), null);
  const main = enrichCandidate(knownCandidate({ title: "Main Agent Benchmark", venue: "NeurIPS" }), { targetVenues: ["NeurIPS"] });
  const workshop = enrichCandidate(knownCandidate({ title: "Workshop Agent Benchmark", venue: "NeurIPS Workshop" }), { targetVenues: ["NeurIPS"] });
  assert.equal(main.ccf_rank, "A");
  assert.equal(main.track_status, "main_conference");
  assert.equal(workshop.venue, "NeurIPS");
  assert.equal(workshop.track_status, "workshop");
  assert.notEqual(workshop.track_status, main.track_status);
});

test("eval: PDF quote extraction preserves page and chunk provenance", () => {
  const chunks: PdfChunkIndexEntry[] = [
    {
      paper_id: "known-paper",
      chunk_id: "p4-c1",
      page: 4,
      text: "The experiment reports a dataset benchmark with a baseline comparison and accuracy metric.",
      char_count: 84,
      text_density: 84,
      extraction_quality: "ok"
    }
  ];
  const rows = extractEvidenceRows(chunks);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.paper_id, "known-paper");
  assert.equal(rows[0]?.page, "4");
  assert.equal(rows[0]?.chunk_id, "p4-c1");
  assert.equal(rows[0]?.quote, chunks[0]!.text.slice(0, 240));
  assert.equal(rows[0]?.status, "verified");

  const badRows = [evidenceRow("known-paper", "baseline", "5", "p4-c1", "This quote does not appear on the claimed page.")];
  const candidates = [knownCandidate({ candidate_id: "known-paper", title: "Known Paper" })];
  assert.deepEqual(trustedEvidenceRows(badRows, chunks), []);
  assert.deepEqual(Object.keys(evidenceRowsMarkdown(badRows, chunks)), []);
  assert.doesNotMatch(relatedWorkMatrixCsv(candidates, [], badRows, chunks), /This quote does not appear/);
  const novelty = assessNovelty("agent benchmark evaluation baseline", candidates, badRows, chunks);
  assert.equal(novelty.evidence_refs.length, 0);
  assert.match(novelty.reasons.join("\n"), /blocked/i);
});

test("eval: scoring is deterministic and improves when evidence gates are resolved", () => {
  const blockedInput = {
    verifiedRelatedWorkCount: 0,
    pdfReadCount: 0,
    corePaperCount: 0,
    evidenceRefs: [],
    hasStrongBaseline: false,
    hasDatasetOrBenchmark: false,
    hasMetric: false,
    hasExecutableExperimentPlan: false,
    hasScientificHypothesis: false
  };
  assert.deepEqual(strictCcfAScore(blockedInput), strictCcfAScore(blockedInput));
  const improved = strictCcfAScore({
    verifiedRelatedWorkCount: 5,
    pdfReadCount: 5,
    corePaperCount: 5,
    evidenceRefs: ["e1", "e2", "e3", "e4", "e5"],
    hasStrongBaseline: true,
    hasDatasetOrBenchmark: true,
    hasMetric: true,
    hasExecutableExperimentPlan: true,
    hasScientificHypothesis: true
  });
  const blocked = strictCcfAScore(blockedInput);
  assert.ok(improved.total > blocked.total);
  assert.equal(blocked.score_type, "Preliminary");
  assert.equal(improved.score_type, "Submission-ready");
  assert.equal(improved.hard_blockers.length, 0);
  assert.equal(improved.score_dimensions.reduce((sum, dimension) => sum + dimension.maxScore, 0), 100);
});

test("eval: offline pipeline artifacts and ledgers do not leak raw chain-of-thought", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-eval-leakage-"));
  try {
    const result = await runResearchPipeline("Build an agent benchmark with literature evidence, metrics, and baselines.", {
      outputRoot: root,
      provider: "offline",
      runId: "eval-leakage",
      strictCcfA: true,
      events: new JsonlEventSink(join(root, ".idea2repo", "trace.jsonl"))
    });
    const trace = await readJsonlEvents(join(root, ".idea2repo", "trace.jsonl"));
    const decisions = await readDecisionRecords(root);
    const persisted = await Promise.all([
      readFile(join(root, ".idea2repo", "evidence.jsonl"), "utf8"),
      readFile(join(root, ".idea2repo", "score_snapshots.jsonl"), "utf8"),
      readFile(join(root, ".idea2repo", "trace.jsonl"), "utf8")
    ]);
    const searchable = [
      ...Object.values(result.artifacts),
      JSON.stringify(trace),
      JSON.stringify(decisions),
      ...persisted
    ].join("\n");
    assertNoRawThoughtMarkers(searchable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eval: offline deterministic pipeline produces stable acceptance artifacts", async () => {
  const idea = "Build a deterministic literature-grounded research reviewer with evidence ledgers and score snapshots.";
  const originalFetch = globalThis.fetch;
  const leftRoot = await mkdtemp(join(tmpdir(), "idea2repo-eval-stable-left-"));
  const rightRoot = await mkdtemp(join(tmpdir(), "idea2repo-eval-stable-right-"));
  try {
    globalThis.fetch = (async () => {
      throw new Error("offline eval must not use network");
    }) as typeof fetch;
    const left = await runResearchPipeline(idea, { outputRoot: leftRoot, provider: "offline", runId: "eval-stable", strictCcfA: true });
    const right = await runResearchPipeline(idea, { outputRoot: rightRoot, provider: "offline", runId: "eval-stable", strictCcfA: true });
    assert.deepEqual(left.searchPlan, right.searchPlan);
    assert.deepEqual(
      left.state.stages.map((stage) => [stage.id, stage.status, stage.artifacts]),
      right.state.stages.map((stage) => [stage.id, stage.status, stage.artifacts])
    );
    for (const path of [
      "reports/ccf_a_readiness_report.md",
      "reports/novelty_matrix.md",
      "reports/related_work.md",
      "reports/evidence_ledger.md",
      "plans/12_week_execution_plan.md",
      "plans/experiment_plan.md",
      "paper/abstract.md",
      "paper/related_work.md",
      "papers/papers.bib",
      "docs/diagnosis/ccf_a_strict_scorecard.md",
      "docs/relative_work/search_plan.json"
    ]) {
      assert.equal(left.artifacts[path], right.artifacts[path], path);
    }
    const calls = [...await readToolCallRecords(leftRoot), ...await readToolCallRecords(rightRoot)];
    assert.equal(calls.some((call) => call.risk.includes("network")), false);
    assert.equal(calls.some((call) => /^github\./.test(call.tool_name)), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(leftRoot, { recursive: true, force: true });
    await rm(rightRoot, { recursive: true, force: true });
  }
});

function knownCandidate(overrides: Partial<PaperCandidate> = {}): PaperCandidate {
  return {
    candidate_id: overrides.candidate_id ?? safePaperId(overrides.title ?? "known paper"),
    title: overrides.title ?? "Known Paper",
    authors: overrides.authors ?? ["Ada Lovelace"],
    year: overrides.year ?? 2026,
    venue: overrides.venue ?? "NeurIPS",
    source_urls: overrides.source_urls ?? ["https://example.org/known-paper"],
    pdf_urls: overrides.pdf_urls ?? ["https://arxiv.org/pdf/2601.00001"],
    abstract: overrides.abstract ?? "Agent benchmark evaluation with dataset metric baseline evidence.",
    retrieval_sources: overrides.retrieval_sources ?? ["test"],
    retrieval_queries: overrides.retrieval_queries ?? ["agent benchmark evaluation"],
    confidence: overrides.confidence ?? "high",
    ...overrides
  };
}

function evidenceRow(paperId: string, claimType: ClaimEvidenceRow["claim_type"], page: string, chunkId: string, quote: string): ClaimEvidenceRow {
  return {
    paper_id: paperId,
    claim: `Verified ${claimType} evidence.`,
    claim_type: claimType,
    required_evidence: "page, quote, and chunk id",
    planned_artifact: `docs/reference/paper_notes/${paperId}.md`,
    status: "verified",
    page,
    section: "evaluation",
    quote,
    chunk_id: chunkId,
    confidence: 0.8
  };
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}

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

async function writeValidPdfProvenance(root: string, paperId: string, text: string): Promise<PdfChunkIndexEntry[]> {
  const pdf = Buffer.from(`%PDF-1.4\n/Type /Page\nstream\n${text}\nendstream\n%%EOF\n`, "latin1");
  await writeBinaryArtifact(root, `docs/reference/pdfs/${paperId}.pdf`, pdf);
  const manifest: PdfManifestRecord[] = [
    {
      paper_id: paperId,
      pdf_path: `docs/reference/pdfs/${paperId}.pdf`,
      pdf_sha256: sha256(pdf),
      source_url: `https://arxiv.org/pdf/${paperId}`,
      downloaded_at: "2026-05-11T00:00:00Z",
      bytes: pdf.byteLength,
      license_hint: "arXiv",
      title_match_score: 1,
      status: "downloaded"
    }
  ];
  await writeArtifact(root, "docs/reference/pdf_manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return await buildPdfChunkIndex(root, manifest);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertNoRawThoughtMarkers(value: string): void {
  for (const marker of [/chain-of-thought/i, /raw thought/i, /hidden reasoning/i, /private reasoning/i, /scratchpad/i]) {
    assert.doesNotMatch(value, marker);
  }
}
