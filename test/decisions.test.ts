import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { DecisionRecorder, formatDecisions, readDecisionRecords } from "../src/runtime/decisions.js";

test("DecisionRecorder writes records and emits decision event", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-decisions-"));
  const events: string[] = [];
  try {
    const recorder = new DecisionRecorder(root, "run-1", {
      emit: (event) => {
        events.push(event.type);
      }
    });
    await recorder.record({
      id: "decision-1",
      stage_id: "idea_intake",
      title: "Route selected",
      rationale_summary: "Visible summary only.",
      inputs_considered: ["idea"],
      evidence_refs: [{ artifact: "docs/idea/idea_brief.md" }],
      alternatives: [{ option: "skip", why_not: "needed" }],
      confidence: "high",
      created_at: "2026-05-11T00:00:00Z"
    });
    const records = await readDecisionRecords(root);
    assert.equal(records[0]?.id, "decision-1");
    assert.equal(records[0]?.rationale_summary.includes("Visible summary"), true);
    assert.deepEqual(events, ["decision.recorded"]);
    assert.match(formatDecisions(records), /Route selected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline records visible decisions and trace --decisions prints them", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-decisions-cli-"));
  const output = join(root, "project");
  try {
    assert.equal(await main(["research", "Build an LLM agent benchmark.", "--offline", "--provider", "offline", "--output", output, "--jsonl-events"]), 0);
    const records = await readDecisionRecords(output);
    assert.ok(records.some((record) => record.stage_id === "idea_intake"));
    assert.ok(records.some((record) => record.stage_id === "ccf_a_strict_scoring"));
    assert.equal(records.some((record) => /chain-of-thought/i.test(record.rationale_summary)), false);
    assert.equal(await main(["trace", "--decisions", "--output", output]), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

