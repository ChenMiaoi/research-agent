import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { generateResearchRepo, resumeResearchRepo } from "../src/generator.js";
import { runResearchPipeline } from "../src/pipeline/research-pipeline.js";
import { markStage, readResearchPipelineState, writeResearchPipelineState } from "../src/pipeline/stage-state.js";
import { listArtifactSnapshots } from "../src/runtime/artifacts.js";
import { readDecisionRecords } from "../src/runtime/decisions.js";
import { readJsonlEvents } from "../src/runtime/events.js";
import { readPlanState } from "../src/runtime/plan.js";
import { readRuntimeRunContext } from "../src/runtime/run-context.js";
import { retryRuntimeStage, skipRuntimeStage } from "../src/runtime/runs.js";
import type { Idea2RepoEvent } from "../src/runtime/events.js";

test("skipRuntimeStage persists blocker plan trace and decision record", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-skip-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("An offline agent runtime benchmark with traceable evidence.", output, {
      offline: true,
      provider: "offline",
      runResearchPipeline: true,
      jsonlEvents: true
    });

    await skipRuntimeStage(output, "pdf_reading", "No downloadable PDFs in offline mode.");
    const state = await readResearchPipelineState(output);
    assert.equal(state?.stages.find((stage) => stage.id === "pdf_reading")?.status, "skipped");
    assert.match(state?.stages.find((stage) => stage.id === "pdf_reading")?.error ?? "", /offline/);
    const plan = await readPlanState(output);
    assert.equal(plan.items.find((item) => item.stage_id === "pdf_reading")?.status, "skipped");
    assert.ok(plan.items.find((item) => item.stage_id === "pdf_reading")?.decision_ids.length);
    assert.ok((await readDecisionRecords(output)).some((record) => record.title.includes("Skipped PDF reading")));
    assert.ok((await readJsonlEvents(join(output, ".idea2repo", "trace.jsonl"))).some((event) => event.type === "stage.skipped" && event.stage_id === "pdf_reading"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retryRuntimeStage snapshots affected artifacts and resets downstream stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-retry-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("A local-first literature agent with CCF-A scoring.", output, {
      offline: true,
      provider: "offline",
      runResearchPipeline: true,
      jsonlEvents: true
    });

    const result = await retryRuntimeStage(output, "search_planning", { execute: false, reason: "Search queries need refinement." });
    assert.equal(result.executed, false);
    assert.ok(result.snapshots.some((snapshot) => snapshot.path === "docs/relative_work/search_plan.json"));
    const state = await readResearchPipelineState(output);
    assert.equal(state?.stages.find((stage) => stage.id === "idea_intake")?.status, "completed");
    assert.equal(state?.stages.find((stage) => stage.id === "search_planning")?.status, "pending");
    assert.equal(state?.stages.find((stage) => stage.id === "ccf_a_strict_scoring")?.status, "pending");
    assert.ok((await listArtifactSnapshots(output)).length >= result.snapshots.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executed retry snapshots pipeline artifacts outside the stage artifact table", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-retry-execute-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("A local-first literature agent with CCF-A scoring.", output, {
      offline: true,
      provider: "offline",
      runResearchPipeline: true,
      jsonlEvents: true
    });

    const result = await retryRuntimeStage(output, "search_planning", { execute: true, reason: "Execute retry with full artifact protection." });
    assert.equal(result.executed, true);
    assert.ok((await listArtifactSnapshots(output)).some((snapshot) => snapshot.path === "docs/reference/claim_evidence_matrix.csv"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executed retry reuses the original run provider and venue context", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-retry-context-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("A local-first literature agent with CCF-A scoring.", output, {
      offline: true,
      provider: "offline",
      model: "gpt-test-model",
      reasoningEffort: "high",
      sources: ["arxiv"],
      venue: "ICLR",
      maxPapers: 7,
      runResearchPipeline: true,
      jsonlEvents: true
    });
    const context = await readRuntimeRunContext(output);
    assert.equal(context?.provider, "offline");
    assert.equal(context?.model, "gpt-test-model");
    assert.equal(context?.reasoning_effort, "high");
    assert.deepEqual(context?.sources, ["arxiv"]);
    assert.equal(context?.venue, "ICLR");
    assert.equal(context?.max_papers, 7);
    assert.equal(context?.approval_policy.allow_network, false);

    await writeFile(join(output, "docs", "submission", "target_venue.md"), "Wrong venue\n", "utf8");
    await retryRuntimeStage(output, "venue_template_packaging", { execute: true, reason: "Retry venue packaging with preserved context." });
    assert.match(await readFile(join(output, "docs", "submission", "target_venue.md"), "utf8"), /ICLR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume restores runtime plan trace approvals and blocks missing stage artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-resume-runtime-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("A local-first literature agent with CCF-A scoring.", output, {
      offline: true,
      provider: "offline",
      runResearchPipeline: true,
      jsonlEvents: true
    });
    const runningState = await readResearchPipelineState(output);
    assert.ok(runningState);
    await writeResearchPipelineState(output, markStage(runningState, "search_planning", "running"));
    await rm(join(output, ".idea2repo", "plan.json"), { force: true });
    await rm(join(output, ".idea2repo", "trace.jsonl"), { force: true });
    await rm(join(output, ".idea2repo", "approvals.jsonl"), { force: true });
    await rm(join(output, "docs", "relative_work", "search_plan.json"), { force: true });

    await resumeResearchRepo(output);

    const state = await readResearchPipelineState(output);
    const searchStage = state?.stages.find((stage) => stage.id === "search_planning");
    assert.equal(searchStage?.status, "failed");
    assert.match(searchStage?.error ?? "", /search_plan\.json/);
    const plan = await readPlanState(output);
    assert.equal(plan.items.find((item) => item.stage_id === "search_planning")?.status, "blocked");
    assert.match(plan.items.find((item) => item.stage_id === "search_planning")?.blocker ?? "", /search_plan\.json/);
    const trace = await readJsonlEvents(join(output, ".idea2repo", "trace.jsonl"));
    assert.ok(trace.some((event) => event.type === "stage.failed" && event.stage_id === "search_planning"));
    assert.ok(trace.some((event) => event.type === "plan.updated"));
    assert.equal(await readFile(join(output, ".idea2repo", "approvals.jsonl"), "utf8"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume continues from the next unfinished pipeline stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-resume-continues-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("A local-first literature agent with CCF-A scoring.", output, {
      offline: true,
      provider: "offline",
      runResearchPipeline: true,
      jsonlEvents: true
    });
    const completedState = await readResearchPipelineState(output);
    assert.ok(completedState);
    await writeResearchPipelineState(output, markStage(completedState, "search_planning", "pending"));
    await rm(join(output, ".idea2repo", "trace.jsonl"), { force: true });

    const resumed = await resumeResearchRepo(output);

    assert.equal(resumed.research_pipeline?.state.stages.find((stage) => stage.id === "search_planning")?.status, "completed");
    assert.ok(resumed.files.some((file) => file.split("\\").join("/").endsWith(".idea2repo/research_pipeline_state.json")));
    const state = await readResearchPipelineState(output);
    assert.equal(state?.stages.find((stage) => stage.id === "search_planning")?.status, "completed");
    const trace = await readJsonlEvents(join(output, ".idea2repo", "trace.jsonl"));
    assert.ok(trace.some((event) => event.type === "stage.started" && event.stage_id === "search_planning"));
    assert.ok(trace.some((event) => event.type === "run.completed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pipeline cancellation emits run.cancelled instead of run.failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-cancel-"));
  const controller = new AbortController();
  const events: Idea2RepoEvent[] = [];
  try {
    await assert.rejects(
      runResearchPipeline("A cancellable agent runtime benchmark.", {
        outputRoot: root,
        provider: "offline",
        runId: "cancel-test",
        signal: controller.signal,
        events: {
          emit: (event) => {
            events.push(event);
          }
        },
        agentClient: {
          intakeIdea: async () => {
            controller.abort("operator cancel");
            throw new Error("operator cancel");
          }
        } as any
      }),
      /operator cancel/
    );
    assert.ok(events.some((event) => event.type === "run.cancelled"));
    assert.ok(!events.some((event) => event.type === "run.failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-aborted pipeline emits run.cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pre-cancel-pipeline-"));
  const controller = new AbortController();
  const events: Idea2RepoEvent[] = [];
  controller.abort("pre-cancel pipeline");
  try {
    await assert.rejects(
      runResearchPipeline("A pre-cancelled agent runtime benchmark.", {
        outputRoot: root,
        provider: "offline",
        runId: "pre-cancel-pipeline",
        signal: controller.signal,
        events: {
          emit: (event) => {
            events.push(event);
          }
        }
      }),
      /pre-cancel pipeline/
    );
    assert.equal(events.filter((event) => event.type === "run.cancelled").length, 1);
    assert.ok(!events.some((event) => event.type === "run.failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generator cancellation after pipeline emits run.cancelled terminal event", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-generator-cancel-"));
  const output = join(root, "project");
  const controller = new AbortController();
  const events: Idea2RepoEvent[] = [];
  try {
    await assert.rejects(
      generateResearchRepo("A cancellable generated repository after pipeline completion.", output, {
        offline: true,
        provider: "offline",
        runResearchPipeline: true,
        signal: controller.signal,
        eventSink: {
          emit: (event) => {
            events.push(event);
          }
        },
        progressCallback: (message) => {
          if (message === "Artifacts: writing repository scaffold") controller.abort("operator cancel after pipeline");
        }
      }),
      /operator cancel after pipeline/
    );
    assert.equal(events.filter((event) => event.type === "run.cancelled").length, 1);
    assert.ok(!events.some((event) => event.type === "run.failed"));
    assert.ok(!events.some((event) => event.type === "run.completed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-aborted generator emits run.cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pre-cancel-generator-"));
  const output = join(root, "project");
  const controller = new AbortController();
  const events: Idea2RepoEvent[] = [];
  controller.abort("pre-cancel generator");
  try {
    await assert.rejects(
      generateResearchRepo("A pre-cancelled generated repository.", output, {
        offline: true,
        provider: "offline",
        runResearchPipeline: true,
        signal: controller.signal,
        eventSink: {
          emit: (event) => {
            events.push(event);
          }
        }
      }),
      /pre-cancel generator/
    );
    assert.equal(events.filter((event) => event.type === "run.cancelled").length, 1);
    assert.ok(!events.some((event) => event.type === "run.failed"));
    assert.ok(!events.some((event) => event.type === "run.completed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI stage and snapshot commands expose recovery controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-recovery-cli-"));
  const output = join(root, "project");
  try {
    assert.equal(
      await main(["research", "A runtime trace benchmark with deterministic evidence gates.", "--offline", "--provider", "offline", "--jsonl-events", "--output", output]),
      0
    );
    assert.equal(await main(["stage", "retry", "search_planning", "--output", output, "--no-execute", "--reason", "Need narrower queries"]), 0);
    const snapshots = await listArtifactSnapshots(output);
    assert.ok(snapshots.length > 0);
    await writeCorruption(output);
    assert.equal(await main(["restore", "--snapshot", snapshots[0]!.id, "--output", output]), 0);
    assert.ok((await readJsonlEvents(join(output, ".idea2repo", "trace.jsonl"))).some((event) => event.type === "artifact.restored"));
    assert.equal(await main(["snapshots", "list", "--output", output]), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeCorruption(output: string): Promise<void> {
  await writeFile(join(output, "docs", "relative_work", "search_plan.json"), "{}\n", "utf8");
  assert.match(await readFile(join(output, "docs", "relative_work", "search_plan.json"), "utf8"), /\{\}/);
}
