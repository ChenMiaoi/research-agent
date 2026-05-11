import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StrictScoreResult } from "../skills/analysis/ccf-a-score.js";
import type { ClaimEvidenceRow } from "../skills/analysis/evidence-extract.js";
import type { PaperCandidate } from "../skills/literature/types.js";
import type { PdfManifestRecord } from "../skills/pdf/provenance.js";
import { runtimeTimestamp } from "./events.js";

export const EVIDENCE_LEDGER_PATH = join(".idea2repo", "evidence.jsonl");
export const SCORE_SNAPSHOTS_LEDGER_PATH = join(".idea2repo", "score_snapshots.jsonl");

const ledgerWriteQueues = new Map<string, Promise<void>>();

export type EvidenceClaimType = "method" | "dataset" | "metric" | "baseline" | "limitation" | "result" | "threat" | "future_work";

export type EvidenceItem = {
  id: string;
  run_id: string;
  stage_id: string;
  current: boolean;
  superseded_at?: string;
  paper_id: string;
  title: string;
  venue?: string;
  year?: number;
  ccf_rank: "A" | "B" | "C" | "unknown";
  source_url?: string;
  doi?: string;
  arxiv_id?: string;
  page: number;
  section?: string;
  quote: string;
  chunk_id: string;
  paraphrase: string;
  claim_type: EvidenceClaimType;
  confidence: number;
  provenance: {
    source: "pdf_chunk";
    artifact: string;
    pdf_path?: string;
    pdf_sha256?: string;
    source_url?: string;
    extracted_at: string;
  };
  timestamp: string;
};

export type ScoreDimensionSnapshot = {
  name: string;
  score: number;
  max_score: number;
  confidence: number;
  rationale: string;
  positive_evidence: string[];
  negative_evidence: string[];
  missing_evidence: string[];
  recommended_actions: string[];
};

export type ScoreSnapshot = {
  id: string;
  run_id: string;
  stage_id: string;
  source: "strict_ccf_a";
  score: number;
  max_score: number;
  confidence: number;
  dimensions: ScoreDimensionSnapshot[];
  hard_blockers: string[];
  caps: StrictScoreResult["caps"];
  evidence_refs: string[];
  missing_evidence: string[];
  recommended_actions: string[];
  timestamp: string;
};

export async function ensureRuntimeLedgers(root: string): Promise<void> {
  await ensureJsonlFile(join(root, EVIDENCE_LEDGER_PATH));
  await ensureJsonlFile(join(root, SCORE_SNAPSHOTS_LEDGER_PATH));
}

export async function replaceEvidenceItems(
  root: string,
  scope: { runId: string; stageId?: string; timestamp?: string },
  items: EvidenceItem[]
): Promise<string> {
  const path = join(root, EVIDENCE_LEDGER_PATH);
  await queueLedgerWrite(path, async () => {
    const existing = await readJsonlFile<EvidenceItem>(path);
    const supersededAt = scope.timestamp ?? runtimeTimestamp();
    const scoped = new Set([`${scope.runId}:${scope.stageId ?? "pdf_reading"}`]);
    const next = existing.map((item) =>
      scoped.has(`${item.run_id}:${item.stage_id}`) && item.current
        ? { ...item, current: false, superseded_at: supersededAt }
        : item
    );
    next.push(...items.map((item) => ({ ...item, current: true })));
    await writeJsonlFile(path, next);
  });
  return path;
}

export async function appendScoreSnapshot(root: string, snapshot: ScoreSnapshot): Promise<string> {
  const path = join(root, SCORE_SNAPSHOTS_LEDGER_PATH);
  await queueLedgerWrite(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(snapshot) + "\n", "utf8");
  });
  return path;
}

export async function readEvidenceLedger(root: string): Promise<EvidenceItem[]> {
  const path = join(root, EVIDENCE_LEDGER_PATH);
  await ledgerWriteQueues.get(path)?.catch(() => undefined);
  return await readJsonlFile<EvidenceItem>(path);
}

export async function readScoreSnapshots(root: string): Promise<ScoreSnapshot[]> {
  const path = join(root, SCORE_SNAPSHOTS_LEDGER_PATH);
  await ledgerWriteQueues.get(path)?.catch(() => undefined);
  return await readJsonlFile<ScoreSnapshot>(path);
}

export function evidenceItemsFromRows(input: {
  runId: string;
  stageId?: string;
  rows: ClaimEvidenceRow[];
  candidates?: PaperCandidate[];
  manifest?: PdfManifestRecord[];
  timestamp?: string;
  confidence?: number;
}): EvidenceItem[] {
  const timestamp = input.timestamp ?? runtimeTimestamp();
  const candidates = candidateLookup(input.candidates ?? []);
  const manifestByPaper = new Map((input.manifest ?? []).map((record) => [record.paper_id, record]));
  return input.rows.flatMap((row) => {
    const page = row.page ? Number(row.page) : NaN;
    if (row.status !== "verified" || !Number.isFinite(page) || !row.quote || !row.chunk_id) return [];
    const candidate = candidates.get(row.paper_id);
    const record = manifestByPaper.get(row.paper_id);
    const sourceUrl = record?.source_url ?? candidate?.pdf_urls[0] ?? candidate?.source_urls[0];
    return [{
      id: `${input.runId}:${input.stageId ?? "pdf_reading"}:${row.paper_id}:${row.chunk_id}:${stableHash([
        timestamp,
        row.claim,
        row.quote,
        input.confidence ?? 0.6,
        record?.pdf_sha256 ?? ""
      ].join("|"))}`,
      run_id: input.runId,
      stage_id: input.stageId ?? "pdf_reading",
      current: true,
      paper_id: row.paper_id,
      title: candidate?.title ?? row.paper_id,
      venue: candidate?.venue,
      year: candidate?.year ?? undefined,
      ccf_rank: "unknown" as const,
      source_url: sourceUrl,
      doi: candidate?.doi,
      arxiv_id: candidate?.arxiv_id,
      page,
      quote: row.quote,
      chunk_id: row.chunk_id,
      paraphrase: row.claim,
      claim_type: claimTypeForText(row.claim),
      confidence: input.confidence ?? 0.6,
      provenance: {
        source: "pdf_chunk" as const,
        artifact: row.planned_artifact,
        pdf_path: record?.pdf_path,
        pdf_sha256: record?.pdf_sha256,
        source_url: sourceUrl,
        extracted_at: timestamp
      },
      timestamp
    }];
  });
}

export function scoreSnapshotFromStrictScore(input: {
  runId: string;
  stageId?: string;
  score: StrictScoreResult;
  confidence?: number;
  evidenceRefs?: string[];
  timestamp?: string;
}): ScoreSnapshot {
  const timestamp = input.timestamp ?? runtimeTimestamp();
  const hardBlockers = input.score.caps.map((cap) => cap.reason);
  const recommendedActions = hardBlockers.map(actionForMissingEvidence);
  return {
    id: `${input.runId}:${input.stageId ?? "ccf_a_strict_scoring"}:${stableHash(`${timestamp}:${input.score.total}:${hardBlockers.join("|")}`)}`,
    run_id: input.runId,
    stage_id: input.stageId ?? "ccf_a_strict_scoring",
    source: "strict_ccf_a",
    score: input.score.total,
    max_score: 100,
    confidence: input.confidence ?? (input.evidenceRefs?.length ? 0.65 : 0.4),
    dimensions: Object.entries(input.score.dimensions).map(([name, value]) => ({
      name,
      score: value,
      max_score: strictDimensionMax(name, value),
      confidence: input.confidence ?? (input.evidenceRefs?.length ? 0.65 : 0.4),
      rationale: `Strict rubric assigned ${value} points for ${name}.`,
      positive_evidence: input.evidenceRefs ?? [],
      negative_evidence: [],
      missing_evidence: hardBlockers,
      recommended_actions: recommendedActions
    })),
    hard_blockers: hardBlockers,
    caps: input.score.caps,
    evidence_refs: input.evidenceRefs ?? [],
    missing_evidence: hardBlockers,
    recommended_actions: recommendedActions,
    timestamp
  };
}

async function ensureJsonlFile(path: string): Promise<void> {
  await queueLedgerWrite(path, async () => {
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeJsonlFile(path, []);
    }
  });
}

async function queueLedgerWrite(path: string, write: () => Promise<void>): Promise<void> {
  const previous = ledgerWriteQueues.get(path) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(write);
  ledgerWriteQueues.set(path, queued);
  try {
    await queued;
  } finally {
    if (ledgerWriteQueues.get(path) === queued) ledgerWriteQueues.delete(path);
  }
}

async function readJsonlFile<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function writeJsonlFile(path: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf8");
}

function candidateLookup(candidates: PaperCandidate[]): Map<string, PaperCandidate> {
  const byId = new Map<string, PaperCandidate>();
  for (const candidate of candidates) {
    for (const key of [candidate.candidate_id, safePaperId(candidate.candidate_id), safePaperId(candidate.title)]) {
      if (key) byId.set(key, candidate);
    }
  }
  return byId;
}

function claimTypeForText(text: string): EvidenceClaimType {
  const normalized = text.toLowerCase();
  if (normalized.includes("dataset") || normalized.includes("benchmark")) return "dataset";
  if (normalized.includes("metric") || normalized.includes("accuracy") || normalized.includes("latency")) return "metric";
  if (normalized.includes("baseline")) return "baseline";
  if (normalized.includes("limitation")) return "limitation";
  if (normalized.includes("threat")) return "threat";
  if (normalized.includes("future work")) return "future_work";
  if (normalized.includes("result")) return "result";
  return "method";
}

function strictDimensionMax(name: string, fallback: number): number {
  const max: Record<string, number> = {
    problem_importance: 15,
    novelty_after_related_work: 20,
    technical_depth: 15,
    experimental_design: 15,
    baseline_dataset_metric: 10,
    venue_fit: 10,
    feasibility: 10,
    reproducibility_open_source_value: 5,
    paper_story: 5
  };
  return max[name] ?? Math.max(fallback, 1);
}

function actionForMissingEvidence(reason: string): string {
  if (/related work|core related papers/i.test(reason)) return "Read and cite enough core related papers with page-level evidence.";
  if (/pdf/i.test(reason)) return "Acquire public PDFs and extract page, quote, and chunk evidence.";
  if (/baseline/i.test(reason)) return "Identify reviewer-expected baselines and link them to evidence.";
  if (/dataset|benchmark/i.test(reason)) return "Define the dataset or benchmark and cite supporting evidence.";
  if (/metric/i.test(reason)) return "Specify primary and secondary metrics with evidence.";
  if (/experiment plan/i.test(reason)) return "Write an executable experiment plan tied to baselines and metrics.";
  if (/threat model/i.test(reason)) return "Write a venue-appropriate threat model.";
  if (/system evaluation|prototype/i.test(reason)) return "Build or scope a prototype with system evaluation metrics.";
  return `Resolve blocker: ${reason}.`;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}
