import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateResearchRepo } from "../src/generator.js";
import { main } from "../src/cli.js";
import { runResearchPipeline } from "../src/pipeline/research-pipeline.js";
import { JsonlEventSink, readJsonlEvents } from "../src/runtime/events.js";

test("research pipeline emits run and stage events to a sink", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-events-"));
  const trace = join(root, ".idea2repo", "trace.jsonl");
  try {
    await runResearchPipeline("Build an LLM agent benchmark with baselines and metrics.", {
      outputRoot: root,
      provider: "offline",
      runId: "run-test",
      events: new JsonlEventSink(trace)
    });

    const events = await readJsonlEvents(trace);
    assert.equal(events[0]?.type, "run.started");
    assert.equal(events.at(-1)?.type, "run.completed");
    assert.ok(events.some((event) => event.type === "stage.started" && event.stage_id === "idea_intake"));
    assert.ok(events.some((event) => event.type === "stage.completed" && event.stage_id === "ccf_a_strict_scoring"));
    assert.ok(events.some((event) => event.type === "stage.skipped" && event.stage_id === "pdf_reading"));
    assert.ok(events.some((event) => event.type === "score.updated" && event.score === 45));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI research --jsonl-events writes trace.jsonl", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-cli-events-"));
  const output = join(root, "project");
  try {
    assert.equal(
      await main([
        "research",
        "Build an LLM agent benchmark with baselines and metrics.",
        "--offline",
        "--provider",
        "offline",
        "--jsonl-events",
        "--output",
        output
      ]),
      0
    );
    const raw = await readFile(join(output, ".idea2repo", "trace.jsonl"), "utf8");
    assert.match(raw, /"run\.started"/);
    assert.match(raw, /"stage\.started"/);
    assert.match(raw, /"score\.updated"/);
    assert.match(raw, /"run\.completed"/);
    const runState = JSON.parse(await readFile(join(output, ".idea2repo", "run_state.json"), "utf8")) as { status: string; event_count: number; last_event_type: string; result?: { project_name?: string } };
    assert.equal(runState.status, "completed");
    assert.equal(runState.last_event_type, "run.completed");
    assert.equal(runState.result?.project_name, "project");
    assert.ok(runState.event_count > 0);
    assert.equal(await readFile(join(output, ".idea2repo", "evidence.jsonl"), "utf8"), "");
    const scoreSnapshots = (await readFile(join(output, ".idea2repo", "score_snapshots.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { score: number; hard_blockers: string[] });
    assert.equal(scoreSnapshots.at(-1)?.score, 45);
    assert.ok(scoreSnapshots.at(-1)?.hard_blockers.includes("No PDF read"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generator persists failed run_state for early validation failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-cli-run-state-failed-"));
  const output = join(root, "project");
  try {
    await assert.rejects(
      generateResearchRepo("Build an LLM agent benchmark.", output, {
        runId: "run-failed",
        timelineWeeks: 10,
        permissionPolicy: {
          allowWrite: true,
          allowOverwrite: false,
          allowNetwork: false,
          allowLogin: false,
          allowInstall: false,
          allowPublish: false
        }
      }),
      /timeline_weeks/
    );
    const runState = JSON.parse(await readFile(join(output, ".idea2repo", "run_state.json"), "utf8")) as { status: string; error?: string; last_event_type?: string };
    assert.equal(runState.status, "failed");
    assert.equal(runState.last_event_type, "run.failed");
    assert.match(runState.error ?? "", /timeline_weeks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generator persists failed run_state for empty idea validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-cli-run-state-empty-"));
  const output = join(root, "project");
  try {
    await assert.rejects(
      generateResearchRepo("", output, {
        runId: "run-empty",
        permissionPolicy: {
          allowWrite: true,
          allowOverwrite: false,
          allowNetwork: false,
          allowLogin: false,
          allowInstall: false,
          allowPublish: false
        }
      }),
      /idea must not be empty/
    );
    const runState = JSON.parse(await readFile(join(output, ".idea2repo", "run_state.json"), "utf8")) as { status: string; error?: string; last_event_type?: string };
    assert.equal(runState.status, "failed");
    assert.equal(runState.last_event_type, "run.failed");
    assert.match(runState.error ?? "", /idea must not be empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
