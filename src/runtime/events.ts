import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RuntimePlanItem = {
  id: string;
  stage_id?: string;
  step: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "skipped";
  blocker?: string;
  artifacts: string[];
  input_refs: string[];
  output_refs: string[];
  evidence_refs: string[];
  decision_ids: string[];
  next_actions: string[];
  updated_at: string;
};

export type PdfExtractionPageEvent = {
  page: number;
  char_count: number;
  text_density: number;
  quality: "empty" | "weak" | "ok";
};

export type EvidenceProvenanceEvent = {
  source: "pdf_chunk";
  artifact: string;
  pdf_path?: string;
  pdf_sha256?: string;
  source_url?: string;
  extracted_at: string;
};

export type Idea2RepoEvent =
  | { type: "run.started"; run_id: string; idea: string; output_root: string; timestamp: string }
  | { type: "run.completed"; run_id: string; timestamp: string }
  | { type: "run.failed"; run_id: string; error: string; timestamp: string }
  | { type: "run.cancelled"; run_id: string; reason?: string; timestamp: string }
  | { type: "stage.started"; run_id: string; stage_id: string; label: string; timestamp: string }
  | { type: "stage.completed"; run_id: string; stage_id: string; artifacts: string[]; timestamp: string }
  | { type: "stage.skipped"; run_id: string; stage_id: string; reason: string; timestamp: string }
  | { type: "stage.failed"; run_id: string; stage_id: string; error: string; timestamp: string }
  | { type: "stage.blocked"; run_id: string; stage_id: string; reason: string; timestamp: string }
  | { type: "plan.updated"; run_id: string; plan: RuntimePlanItem[]; timestamp: string }
  | { type: "decision.recorded"; run_id: string; decision_id: string; stage_id?: string; title: string; timestamp: string }
  | { type: "artifact.written"; run_id: string; path: string; sha256: string; bytes: number; timestamp: string }
  | { type: "artifact.snapshot"; run_id: string; snapshot_id: string; path: string; timestamp: string }
  | { type: "artifact.restored"; run_id: string; snapshot_id: string; path: string; timestamp: string }
  | { type: "tool.started"; run_id: string; tool_call_id: string; tool_name: string; timestamp: string }
  | { type: "tool.completed"; run_id: string; tool_call_id: string; success: boolean; summary: string; timestamp: string }
  | { type: "approval.requested"; run_id: string; approval_id: string; stage_id?: string; action: string; risk: string; timestamp: string }
  | { type: "approval.resolved"; run_id: string; approval_id: string; decision: "approved" | "denied"; timestamp: string }
  | {
      type: "paper.found";
      run_id: string;
      paper_id: string;
      title: string;
      stage_id?: string;
      venue?: string;
      year?: number | null;
      relevance_score?: number;
      ccf_rank?: "A" | "B" | "C" | "unknown";
      venue_match?: "target" | "primary" | "secondary" | "ccf_a" | "known" | "unknown";
      track_status?: "main_conference" | "journal" | "workshop" | "demo" | "short_paper" | "unknown";
      novelty_risk?: "high" | "medium" | "low" | "unknown";
      pdf_status?: "available" | "unavailable" | "needs_approval" | "downloaded";
      reason?: string;
      timestamp: string;
    }
  | {
      type: "pdf.downloaded";
      run_id: string;
      paper_id: string;
      path: string;
      sha256: string;
      bytes: number;
      source_url?: string;
      extraction_quality?: "empty" | "weak" | "ok";
      mean_chars_per_page?: number;
      weak_pages?: number[];
      extraction_pages?: PdfExtractionPageEvent[];
      timestamp: string;
    }
  | {
      type: "evidence.extracted";
      run_id: string;
      evidence_id: string;
      paper_id: string;
      title?: string;
      venue?: string;
      claim: string;
      claim_type: "method" | "dataset" | "metric" | "baseline" | "limitation" | "result" | "threat" | "future_work";
      page: number;
      section?: string;
      quote: string;
      chunk_id: string;
      confidence: number;
      provenance?: EvidenceProvenanceEvent;
      timestamp: string;
    }
  | {
      type: "paper.note.written";
      run_id: string;
      paper_id: string;
      path: string;
      status: "verified" | "metadata_only";
      evidence_rows: number;
      title?: string;
      timestamp: string;
    }
  | {
      type: "question.asked";
      run_id: string;
      question_id: string;
      question: string;
      why_it_matters: string;
      related_score_dimensions: string[];
      evidence_refs: string[];
      options?: string[];
      required: boolean;
      timestamp: string;
    }
  | {
      type: "score.updated";
      run_id: string;
      stage_id?: string;
      score: number;
      max_score: number;
      confidence: number;
      hard_blockers: string[];
      timestamp: string;
    }
  | {
      type: "reviewer.reported";
      run_id: string;
      reviewer_id: "R1" | "R2" | "R3";
      role: string;
      verdict: "Weak reject" | "Borderline" | "Weak accept";
      artifact: string;
      open_tasks: number;
      timestamp: string;
    }
  | {
      type: "rebuttal.task.created";
      run_id: string;
      task_id: string;
      reviewer_id: "R1" | "R2" | "R3";
      title: string;
      binding_type: "paper_note" | "evidence_ref" | "score_dimension";
      binding_ref: string;
      score_dimension?: string;
      evidence_refs: string[];
      timestamp: string;
    }
  | {
      type: "rebuttal.task.resolved";
      run_id: string;
      task_id: string;
      reviewer_id: "R1" | "R2" | "R3";
      score_snapshot_id: string;
      timestamp: string;
    };

export interface EventSink {
  emit(event: Idea2RepoEvent): Promise<void> | void;
}

export type EventListener = (event: Idea2RepoEvent) => void;

export class EventBus implements EventSink {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: Idea2RepoEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

export class JsonlEventSink implements EventSink {
  constructor(private readonly path: string) {}

  async emit(event: Idea2RepoEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export class CompositeEventSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}

  async emit(event: Idea2RepoEvent): Promise<void> {
    for (const sink of this.sinks) await sink.emit(event);
  }
}

export function runtimeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function readJsonlEvents(path: string): Promise<Idea2RepoEvent[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Idea2RepoEvent);
}
