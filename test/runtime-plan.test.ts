import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { researchStages } from "../src/pipeline/stages.js";
import { createPlanState, formatPlan, PlanEventSink, readPlanState, updatePlanForStageEvent } from "../src/runtime/plan.js";

test("createPlanState derives items from research stages", () => {
  const plan = createPlanState("run-1", "2026-05-11T00:00:00Z");
  assert.equal(plan.version, 1);
  assert.equal(plan.items.length, researchStages.length);
  assert.equal(plan.items[0]?.stage_id, "idea_intake");
  assert.deepEqual(plan.items[0]?.input_refs, ["idea"]);
  assert.ok(plan.items[1]?.input_refs.includes("docs/idea/idea_brief.md"));
  assert.deepEqual(plan.items[0]?.decision_ids, []);
  assert.ok(plan.items[0]?.next_actions.length);
  assert.equal(plan.items.every((item) => item.status === "pending"), true);
});

test("updatePlanForStageEvent keeps at most one item in progress and tracks refs", () => {
  let plan = createPlanState("run-1", "2026-05-11T00:00:00Z");
  plan = updatePlanForStageEvent(plan, { type: "stage.started", run_id: "run-1", stage_id: "idea_intake", label: "Idea intake", timestamp: "2026-05-11T00:00:01Z" });
  plan = updatePlanForStageEvent(plan, { type: "stage.started", run_id: "run-1", stage_id: "search_planning", label: "Search planning", timestamp: "2026-05-11T00:00:02Z" });
  assert.equal(plan.items.filter((item) => item.status === "in_progress").length, 1);
  assert.equal(plan.items.find((item) => item.stage_id === "idea_intake")?.status, "pending");
  plan = updatePlanForStageEvent(plan, { type: "stage.skipped", run_id: "run-1", stage_id: "search_planning", reason: "blocked", timestamp: "2026-05-11T00:00:03Z" });
  assert.equal(plan.items.find((item) => item.stage_id === "search_planning")?.status, "skipped");
  assert.match(formatPlan(plan), /blocked/);
  plan = updatePlanForStageEvent(plan, { type: "decision.recorded", run_id: "run-1", stage_id: "search_planning", decision_id: "decision-1", title: "Search decision", timestamp: "2026-05-11T00:00:04Z" });
  assert.deepEqual(plan.items.find((item) => item.stage_id === "search_planning")?.decision_ids, ["decision-1"]);
  plan = updatePlanForStageEvent(plan, { type: "evidence.extracted", run_id: "run-1", evidence_id: "e1", paper_id: "paper-1", claim: "claim", claim_type: "baseline", page: 1, quote: "quote", chunk_id: "c1", confidence: 0.7, timestamp: "2026-05-11T00:00:05Z" });
  assert.deepEqual(plan.items.find((item) => item.stage_id === "pdf_reading")?.evidence_refs, ["e1"]);
});

test("PlanEventSink persists plan updates and emits downstream plan.updated", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-plan-"));
  const downstream: string[] = [];
  try {
    const sink = new PlanEventSink(root, "run-1", {
      emit: (event) => {
        downstream.push(event.type);
      }
    });
    await sink.emit({ type: "stage.started", run_id: "run-1", stage_id: "idea_intake", label: "Idea intake", timestamp: "2026-05-11T00:00:00Z" });
    const plan = await readPlanState(root);
    assert.equal(plan.items.find((item) => item.stage_id === "idea_intake")?.status, "in_progress");
    assert.deepEqual(downstream, ["stage.started", "plan.updated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI research writes plan.json and plan command prints it", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-plan-cli-"));
  const output = join(root, "project");
  try {
    assert.equal(await main(["research", "Build an LLM agent benchmark.", "--offline", "--provider", "offline", "--output", output]), 0);
    const plan = await readPlanState(output);
    assert.equal(plan.items.find((item) => item.stage_id === "idea_intake")?.status, "completed");
    assert.equal(await main(["plan", "--output", output]), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
