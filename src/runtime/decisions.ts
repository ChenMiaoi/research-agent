import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeTimestamp, type EventSink } from "./events.js";

export const DECISIONS_PATH = join(".idea2repo", "decisions.jsonl");

export type DecisionRecord = {
  id: string;
  run_id: string;
  stage_id?: string;
  title: string;
  rationale_summary: string;
  inputs_considered: string[];
  evidence_refs: Array<{
    artifact: string;
    page?: number;
    quote?: string;
    chunk_id?: string;
  }>;
  alternatives: Array<{
    option: string;
    why_not: string;
  }>;
  confidence: "low" | "medium" | "high";
  created_at: string;
};

export type DecisionInput = Omit<DecisionRecord, "id" | "run_id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

export class DecisionRecorder {
  constructor(
    private readonly root: string,
    private readonly runId: string,
    private readonly events?: EventSink
  ) {}

  async record(input: DecisionInput): Promise<DecisionRecord> {
    const record: DecisionRecord = {
      id: input.id ?? randomUUID(),
      run_id: this.runId,
      stage_id: input.stage_id,
      title: input.title,
      rationale_summary: input.rationale_summary,
      inputs_considered: input.inputs_considered,
      evidence_refs: input.evidence_refs,
      alternatives: input.alternatives,
      confidence: input.confidence,
      created_at: input.created_at ?? runtimeTimestamp()
    };
    const path = join(this.root, DECISIONS_PATH);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    await this.events?.emit({
      type: "decision.recorded",
      run_id: this.runId,
      decision_id: record.id,
      ...(record.stage_id ? { stage_id: record.stage_id } : {}),
      title: record.title,
      timestamp: record.created_at
    });
    return record;
  }
}

export async function readDecisionRecords(root: string): Promise<DecisionRecord[]> {
  const raw = await readFile(join(root, DECISIONS_PATH), "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionRecord);
}

export function formatDecisions(records: DecisionRecord[]): string {
  return records.map((record) => `- ${record.title} [${record.confidence}]${record.stage_id ? ` (${record.stage_id})` : ""}: ${record.rationale_summary}`).join("\n");
}

