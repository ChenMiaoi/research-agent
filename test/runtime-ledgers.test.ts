import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strictCcfAScore } from "../src/skills/analysis/ccf-a-score.js";
import type { ClaimEvidenceRow } from "../src/skills/analysis/evidence-extract.js";
import {
  appendScoreSnapshot,
  ensureRuntimeLedgers,
  evidenceItemsFromRows,
  readEvidenceLedger,
  readScoreSnapshots,
  replaceEvidenceItems,
  scoreSnapshotFromStrictScore,
  validateEvidenceItem,
} from "../src/runtime/ledgers.js";

test("evidence ledger versions verified PDF evidence by run scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-evidence-ledger-"));
  try {
    const rows: ClaimEvidenceRow[] = [
      {
        paper_id: "paper-1",
        claim: "PDF evidence mentions baseline comparison.",
        claim_type: "baseline",
        required_evidence: "page, quote, and chunk id",
        planned_artifact: "docs/reference/paper_notes/paper-1.md",
        status: "verified",
        page: "2",
        section: "evaluation",
        quote: "baseline comparison",
        chunk_id: "paper-1-p2-c1",
        confidence: 0.7
      }
    ];
    const chunks = [{
      paper_id: "paper-1",
      chunk_id: "paper-1-p2-c1",
      page: 2,
      text: "The evaluation reports a baseline comparison against prior benchmarks.",
      char_count: 69,
      text_density: 69,
      extraction_quality: "weak" as const
    }];
    const firstItems = evidenceItemsFromRows({
      runId: "run-1",
      stageId: "pdf_reading",
      rows,
      chunks,
      candidates: [
        {
          candidate_id: "paper-1",
          title: "Agent Benchmark Evaluation",
          authors: ["Ada Lovelace"],
          year: 2026,
          venue: "NeurIPS",
          doi: "10.1000/test",
          arxiv_id: "2601.00001",
          source_urls: ["https://example.org/paper"],
          pdf_urls: ["https://arxiv.org/pdf/2601.00001"],
          retrieval_sources: ["test"],
          retrieval_queries: ["agent benchmark"],
          confidence: "high"
        }
      ],
      manifest: [
        {
          paper_id: "paper-1",
          pdf_path: "docs/reference/pdfs/paper-1.pdf",
          pdf_sha256: "abc",
          source_url: "https://arxiv.org/pdf/2601.00001",
          bytes: 100,
          license_hint: "arXiv",
          status: "downloaded"
        }
      ],
      timestamp: "2026-05-11T00:00:00Z"
    });
    const secondItems = evidenceItemsFromRows({
      runId: "run-1",
      stageId: "pdf_reading",
      rows,
      manifest: [
        {
          paper_id: "paper-1",
          pdf_path: "docs/reference/pdfs/paper-1.pdf",
          pdf_sha256: "def",
          source_url: "https://arxiv.org/pdf/2601.00001",
          bytes: 100,
          license_hint: "arXiv",
          status: "downloaded"
        }
      ],
      chunks,
      timestamp: "2026-05-11T00:01:00Z",
      confidence: 0.8
    });

    assert.equal(firstItems.length, 1);
    assert.equal(secondItems.length, 1);
    assert.equal(validateEvidenceItem(firstItems[0]!), true);
    assert.notEqual(firstItems[0]?.id, secondItems[0]?.id);
    assert.equal(firstItems[0]?.claim_type, "baseline");
    assert.equal(firstItems[0]?.section, "evaluation");
    assert.equal(firstItems[0]?.provenance.artifact, "docs/reference/pdf_chunks.json");
    assert.deepEqual(evidenceItemsFromRows({
      runId: "run-1",
      stageId: "pdf_reading",
      rows: [{ ...rows[0]!, quote: "fabricated claim not present in chunk" }],
      chunks
    }), []);
    assert.deepEqual(evidenceItemsFromRows({
      runId: "run-1",
      stageId: "pdf_reading",
      rows
    }), []);
    await replaceEvidenceItems(root, { runId: "run-1", stageId: "pdf_reading", timestamp: "2026-05-11T00:00:30Z" }, firstItems);
    await appendScoreSnapshot(root, scoreSnapshotFromStrictScore({
      runId: "run-1",
      score: strictCcfAScore({ verifiedRelatedWorkCount: 1, pdfReadCount: 1, corePaperCount: 1, hasStrongBaseline: true }),
      evidenceRefs: firstItems.map((item) => item.id),
      timestamp: "2026-05-11T00:00:40Z"
    }));
    await replaceEvidenceItems(root, { runId: "run-1", stageId: "pdf_reading", timestamp: "2026-05-11T00:01:30Z" }, secondItems);

    const ledger = await readEvidenceLedger(root);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.id, firstItems[0]?.id);
    assert.equal(ledger[0]?.current, false);
    assert.equal(ledger[0]?.superseded_at, "2026-05-11T00:01:30Z");
    assert.equal(ledger[1]?.id, secondItems[0]?.id);
    assert.equal(ledger[1]?.paper_id, "paper-1");
    assert.equal(ledger[1]?.page, 2);
    assert.equal(ledger[1]?.quote, "baseline comparison");
    assert.equal(ledger[1]?.chunk_id, "paper-1-p2-c1");
    assert.equal(ledger[1]?.confidence, 0.8);
    assert.equal(ledger[1]?.current, true);
    assert.equal(ledger[1]?.provenance.pdf_sha256, "def");
    assert.equal((await readScoreSnapshots(root))[0]?.evidence_refs[0], firstItems[0]?.id);

    await replaceEvidenceItems(root, { runId: "run-1", stageId: "pdf_reading", timestamp: "2026-05-11T00:02:00Z" }, []);
    assert.deepEqual((await readEvidenceLedger(root)).filter((item) => item.run_id === "run-1" && item.current), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("score snapshot ledger appends strict CCF-A score snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-score-ledger-"));
  try {
    await ensureRuntimeLedgers(root);
    const score = strictCcfAScore({
      verifiedRelatedWorkCount: 0,
      pdfReadCount: 0,
      corePaperCount: 0,
      hasStrongBaseline: false,
      hasDatasetOrBenchmark: false,
      hasMetric: false,
      hasExecutableExperimentPlan: false
    });
    await appendScoreSnapshot(root, scoreSnapshotFromStrictScore({
      runId: "run-1",
      score,
      evidenceRefs: [],
      timestamp: "2026-05-11T00:00:00Z"
    }));

    const snapshots = await readScoreSnapshots(root);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.score, 39);
    assert.equal(snapshots[0]?.max_score, 100);
    assert.equal(snapshots[0]?.score_type, "Preliminary");
    assert.ok(snapshots[0]?.hard_blockers.includes("No PDF read"));
    assert.equal(snapshots[0]?.dimensions.length, 8);
    assert.ok(snapshots[0]?.soft_weaknesses.length);
    assert.ok(snapshots[0]?.path_to_70.some((action) => /PDF|related|dataset|metric|experiment/i.test(action)));
    assert.ok(snapshots[0]?.path_to_80.some((action) => /PDF|provenance|ablations|related/i.test(action)));
    assert.ok(snapshots[0]?.dimensions.some((dimension) => dimension.name === "Experimental Rigor" && dimension.missing_evidence.includes("Strong baseline")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
