import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CompositeEventSink, EventBus, JsonlEventSink, readJsonlEvents, runtimeTimestamp, type Idea2RepoEvent } from "../src/runtime/events.js";
import { RUN_STATE_PATH, RunStateEventSink, createRunState, readRunState, writeRunState } from "../src/runtime/run-state.js";

test("EventBus publishes events to subscribers and supports unsubscribe", () => {
  const bus = new EventBus();
  const events: Idea2RepoEvent[] = [];
  const unsubscribe = bus.subscribe((event) => events.push(event));
  const event = { type: "run.started", run_id: "run-1", idea: "test", output_root: "out", timestamp: runtimeTimestamp(new Date("2026-05-11T00:00:00Z")) } satisfies Idea2RepoEvent;

  bus.emit(event);
  unsubscribe();
  bus.emit({ type: "run.completed", run_id: "run-1", timestamp: event.timestamp });

  assert.deepEqual(events, [event]);
});

test("JsonlEventSink appends typed events and creates parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-events-"));
  const path = join(root, ".idea2repo", "trace.jsonl");
  try {
    const sink = new JsonlEventSink(path);
    await sink.emit({ type: "stage.started", run_id: "run-1", stage_id: "idea_intake", label: "Idea intake", timestamp: "2026-05-11T00:00:00Z" });
    await sink.emit({ type: "stage.completed", run_id: "run-1", stage_id: "idea_intake", artifacts: ["docs/idea/idea_brief.md"], timestamp: "2026-05-11T00:00:01Z" });

    const events = await readJsonlEvents(path);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "stage.started");
    assert.equal(events[1]?.type, "stage.completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CompositeEventSink forwards events in order", async () => {
  const seen: string[] = [];
  const sink = new CompositeEventSink([
    {
      emit: (event) => {
        seen.push(`a:${event.type}`);
      }
    },
    {
      emit: (event) => {
        seen.push(`b:${event.type}`);
      }
    }
  ]);

  await sink.emit({ type: "run.completed", run_id: "run-1", timestamp: "2026-05-11T00:00:00Z" });

  assert.deepEqual(seen, ["a:run.completed", "b:run.completed"]);
});

test("RunStateEventSink persists run status from events", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-run-state-"));
  try {
    const sink = new RunStateEventSink(root, "run-1", {
      idea: "test idea",
      outputRoot: root,
      now: "2026-05-11T00:00:00Z"
    });
    await sink.emit({ type: "run.started", run_id: "run-1", idea: "test idea", output_root: root, timestamp: "2026-05-11T00:00:01Z" });
    await sink.emit({ type: "stage.blocked", run_id: "run-1", stage_id: "literature_search", reason: "Waiting for network approval", timestamp: "2026-05-11T00:00:02Z" });
    assert.equal((await readRunState(root)).status, "blocked");
    await sink.emit({ type: "stage.started", run_id: "run-1", stage_id: "literature_search", label: "Literature search", timestamp: "2026-05-11T00:00:03Z" });
    await sink.emit({ type: "score.updated", run_id: "run-1", stage_id: "ccf_a_strict_scoring", score: 45, max_score: 100, confidence: 0.4, hard_blockers: ["No PDF read"], timestamp: "2026-05-11T00:00:04Z" });
    await sink.emit({ type: "run.completed", run_id: "run-1", timestamp: "2026-05-11T00:00:05Z" });

    const state = await readRunState(root);
    assert.equal(state.id, "run-1");
    assert.equal(state.status, "completed");
    assert.equal(state.event_count, 5);
    assert.equal(state.last_event_type, "run.completed");
    assert.equal(await readRunState(root).then(() => true), true);
    assert.equal(RUN_STATE_PATH, join(".idea2repo", "run_state.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeRunState preserves terminal state against stale non-terminal writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-run-state-race-"));
  try {
    const base = createRunState({
      runId: "run-1",
      idea: "test idea",
      outputRoot: root,
      now: "2026-05-11T00:00:00Z"
    });
    await writeRunState(root, base);
    await writeRunState(root, {
      ...base,
      status: "completed",
      updated_at: "2026-05-11T00:00:03Z",
      event_count: 3,
      last_event_type: "run.completed",
      result: { project_name: "project" }
    });
    await writeRunState(root, {
      ...base,
      status: "running",
      updated_at: "2026-05-11T00:00:02Z",
      event_count: 2,
      last_event_type: "stage.started"
    });

    const state = await readRunState(root);
    assert.equal(state.status, "completed");
    assert.equal(state.last_event_type, "run.completed");
    assert.deepEqual(state.result, { project_name: "project" });
    assert.equal(state.event_count, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research-native runtime events round-trip through JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-research-events-"));
  const path = join(root, ".idea2repo", "trace.jsonl");
  try {
    const sink = new JsonlEventSink(path);
    const events: Idea2RepoEvent[] = [
      { type: "paper.found", run_id: "run-1", stage_id: "literature_search", paper_id: "p1", title: "Paper", venue: "ACL", year: 2025, relevance_score: 0.9, novelty_risk: "unknown", pdf_status: "available", timestamp: "2026-05-11T00:00:00Z" },
      {
        type: "pdf.downloaded",
        run_id: "run-1",
        paper_id: "p1",
        path: "docs/reference/pdfs/p1.pdf",
        sha256: "abc",
        bytes: 100,
        extraction_quality: "weak",
        mean_chars_per_page: 120,
        weak_pages: [1],
        extraction_pages: [{ page: 1, char_count: 120, text_density: 120, quality: "weak" }],
        timestamp: "2026-05-11T00:00:01Z"
      },
      { type: "evidence.extracted", run_id: "run-1", evidence_id: "e1", paper_id: "p1", claim: "PDF evidence mentions baseline comparison.", claim_type: "baseline", page: 1, quote: "baseline comparison", chunk_id: "p1-p1-c1", confidence: 0.6, timestamp: "2026-05-11T00:00:02Z" },
      { type: "paper.note.written", run_id: "run-1", paper_id: "p1", path: "docs/reference/paper_notes/p1.md", status: "verified", evidence_rows: 1, title: "Paper", timestamp: "2026-05-11T00:00:02Z" },
      { type: "question.asked", run_id: "run-1", question_id: "q1", question: "Which dataset is primary?", why_it_matters: "Experimental rigor is underspecified.", related_score_dimensions: ["Experimental Rigor"], evidence_refs: ["e1"], options: ["A", "B"], required: true, timestamp: "2026-05-11T00:00:03Z" },
      { type: "reviewer.reported", run_id: "run-1", reviewer_id: "R1", role: "Novelty / Related Work", verdict: "Weak reject", artifact: "docs/diagnosis/reviewer_1.md", open_tasks: 1, timestamp: "2026-05-11T00:00:04Z" },
      { type: "rebuttal.task.created", run_id: "run-1", task_id: "R1-M1", reviewer_id: "R1", title: "Add related work.", binding_type: "score_dimension", binding_ref: "related_work", score_dimension: "related_work", evidence_refs: ["e1"], timestamp: "2026-05-11T00:00:05Z" },
      { type: "rebuttal.task.resolved", run_id: "run-1", task_id: "R1-M1", reviewer_id: "R1", score_snapshot_id: "s1", timestamp: "2026-05-11T00:00:06Z" },
      { type: "stage.blocked", run_id: "run-1", stage_id: "pdf_acquisition", reason: "Waiting for PDF approval", timestamp: "2026-05-11T00:00:07Z" }
    ];
    for (const event of events) await sink.emit(event);

    const restored = await readJsonlEvents(path);
    assert.deepEqual(restored.map((event) => event.type), events.map((event) => event.type));
    const pdfEvent = restored.find((event) => event.type === "pdf.downloaded");
    assert.deepEqual(pdfEvent?.extraction_pages, [{ page: 1, char_count: 120, text_density: 120, quality: "weak" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
