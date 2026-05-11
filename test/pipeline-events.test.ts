import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
    assert.match(raw, /"run\.completed"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

