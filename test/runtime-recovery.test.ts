import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { generateResearchRepo } from "../src/generator.js";
import { runResearchPipeline } from "../src/pipeline/research-pipeline.js";
import { readResearchPipelineState } from "../src/pipeline/stage-state.js";
import { listArtifactSnapshots } from "../src/runtime/artifacts.js";
import { readDecisionRecords } from "../src/runtime/decisions.js";
import { readJsonlEvents } from "../src/runtime/events.js";
import { readPlanState } from "../src/runtime/plan.js";
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
    assert.equal(plan.items.find((item) => item.stage_id === "pdf_reading")?.status, "blocked");
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
