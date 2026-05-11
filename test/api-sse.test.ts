import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startApiServer } from "../src/api.js";
import { ApprovalRecorder, approvalPolicyForMode } from "../src/runtime/approvals.js";
import { listArtifactSnapshots } from "../src/runtime/artifacts.js";
import { readJsonlEvents } from "../src/runtime/events.js";
import { appendScoreSnapshot, evidenceItemsFromRows, replaceEvidenceItems, scoreSnapshotFromStrictScore } from "../src/runtime/ledgers.js";
import { strictCcfAScore } from "../src/skills/analysis/ccf-a-score.js";

test("runtime API starts runs and streams shared runtime events over SSE", async () => {
  const server = await startApiServer({ port: 0 });
  const root = await mkdtemp(join(tmpdir(), "idea2repo-api-sse-"));
  const output = join(root, "project");
  try {
    const started = await postJson(`${server.url}/runs`, {
      idea: "A local-first agent runtime with evidence-gated literature review and live plan updates.",
      output,
      mode: "research",
      allow_network: false,
      offline: true,
      provider: "offline",
      run_research_pipeline: true,
      force: false
    });
    assert.equal(started.status, "queued");
    assert.equal(typeof started.run_id, "string");
    assert.equal(started.mode, "research");
    assert.equal(started.legacy_mode, "generate");
    assert.match(started.event_replay_url, /\/events\/replay$/);
    assert.match(started.evidence_url, /\/evidence$/);
    assert.match(started.score_snapshots_url, /\/scores$/);

    const eventsResponse = await fetch(`${server.url}/runs/${started.run_id}/events`);
    const eventsText = await eventsResponse.text();
    assert.equal(eventsResponse.ok, true, eventsText);
    assert.match(eventsText, /event: run\.started/);
    assert.match(eventsText, /event: stage\.started/);
    assert.match(eventsText, /event: plan\.updated/);
    assert.match(eventsText, /event: artifact\.written/);
    assert.match(eventsText, /event: run\.completed/);
    assert.ok(eventsText.indexOf("event: artifact.written") < eventsText.lastIndexOf("event: run.completed"));

    const replay = await getJson(`${server.url}/runs/${started.run_id}/events/replay`);
    assert.ok(Array.isArray(replay.events));
    assert.ok(replay.events.some((event: { type: string }) => event.type === "score.updated"));

    const run = await getJson(`${server.url}/runs/${started.run_id}`);
    assert.equal(run.status, "completed");
    assert.ok(Number(run.event_count) > 0);
    assert.equal(run.mode, "research");
    assert.equal(run.legacy_mode, "generate");
    assert.match(run.events_url, /\/events$/);
    await waitForRunResult(server.url, String(started.run_id));

    const listed = await getJson(`${server.url}/runs`);
    const listedRun = listed.runs.find((entry: { run_id: string }) => entry.run_id === started.run_id);
    assert.equal(listedRun.mode, "research");
    assert.equal(listedRun.legacy_mode, "generate");
    assert.match(listedRun.events_url, /\/events$/);
    assert.match(listedRun.event_replay_url, /\/events\/replay$/);
    assert.match(listedRun.artifacts_url, /\/artifacts$/);
    assert.match(listedRun.evidence_url, /\/evidence$/);
    assert.match(listedRun.score_snapshots_url, /\/scores$/);

    const plan = await getJson(`${server.url}/runs/${started.run_id}/plan`);
    assert.equal(plan.plan.version, 1);
    assert.ok(Array.isArray(plan.plan.items));

    const decisions = await getJson(`${server.url}/runs/${started.run_id}/decisions`);
    assert.ok(Array.isArray(decisions.decisions));
    assert.ok(decisions.decisions.length > 0);

    const artifacts = await getJson(`${server.url}/runs/${started.run_id}/artifacts`);
    assert.ok(Array.isArray(artifacts.artifacts));
    assert.ok(artifacts.artifacts.some((entry: { path: string }) => entry.path === ".idea2repo/trace.jsonl"));
    assert.ok(Array.isArray(artifacts.projections.runtime));
    assert.ok(Array.isArray(artifacts.projections.evidence));
    assert.ok(artifacts.projections.runtime.some((entry: { path: string }) => entry.path === ".idea2repo/trace.jsonl"));

    const evidence = await getJson(`${server.url}/runs/${started.run_id}/evidence`);
    assert.ok(Array.isArray(evidence.evidence));
    assert.ok(Array.isArray(evidence.current));
    const scores = await getJson(`${server.url}/runs/${started.run_id}/scores`);
    assert.ok(scores.score_snapshots.some((snapshot: { score: number; hard_blockers: string[] }) => snapshot.score === 45 && snapshot.hard_blockers.includes("No PDF read")));
    await replaceEvidenceItems(output, { runId: "other-run", stageId: "pdf_reading" }, evidenceItemsFromRows({
      runId: "other-run",
      rows: [
        {
          paper_id: "paper-1",
          claim: "PDF evidence mentions baseline comparison.",
          required_evidence: "page, quote, and chunk id",
          planned_artifact: "docs/reference/paper_notes/paper-1.md",
          status: "verified",
          page: "1",
          quote: "baseline comparison",
          chunk_id: "paper-1-c1"
        }
      ]
    }));
    await appendScoreSnapshot(output, scoreSnapshotFromStrictScore({ runId: "other-run", score: strictCcfAScore({}) }));
    const filteredEvidence = await getJson(`${server.url}/runs/${started.run_id}/evidence`);
    assert.equal(filteredEvidence.evidence.some((item: { run_id: string }) => item.run_id === "other-run"), false);
    const filteredScores = await getJson(`${server.url}/runs/${started.run_id}/scores`);
    assert.equal(filteredScores.score_snapshots.some((snapshot: { run_id: string }) => snapshot.run_id === "other-run"), false);

    const trace = await readJsonlEvents(join(output, ".idea2repo", "trace.jsonl"));
    const firstArtifactIndex = trace.findIndex((event) => event.type === "artifact.written");
    const finalRunCompletedIndex = trace.map((event) => event.type).lastIndexOf("run.completed");
    assert.ok(firstArtifactIndex >= 0);
    assert.ok(finalRunCompletedIndex > firstArtifactIndex);
    assert.equal(trace.at(-1)?.type, "run.completed");

    const skipped = await postJson(`${server.url}/runs/${started.run_id}/stages/pdf_reading/skip`, { reason: "Manual API skip for offline recovery test." });
    assert.equal(skipped.action, "skip");
    assert.equal(skipped.stage_id, "pdf_reading");
    const retried = await postJson(`${server.url}/runs/${started.run_id}/stages/search_planning/retry`, { execute: false, reason: "Manual API retry preparation." });
    assert.equal(retried.action, "retry");
    assert.equal(retried.stage_id, "search_planning");
    const snapshots = await listArtifactSnapshots(output);
    assert.ok(snapshots.length > 0);
    const restored = await postJson(`${server.url}/runs/${started.run_id}/artifacts/restore`, { snapshot_id: snapshots[0]!.id });
    assert.equal(restored.id, snapshots[0]!.id);
    const pending = await new ApprovalRecorder(output, approvalPolicyForMode("publish")).request({
      run_id: String(started.run_id),
      action: "Manual API approval test",
      risk: ["publish"]
    });
    const approval = await postJson(`${server.url}/runs/${started.run_id}/approvals/${pending.id}`, { decision: "denied", reason: "API fanout test." });
    assert.equal(approval.status, "denied");
    const controlEventsText = await (await fetch(`${server.url}/runs/${started.run_id}/events`)).text();
    assert.match(controlEventsText, /event: stage\.skipped/);
    assert.match(controlEventsText, /event: plan\.updated/);
    assert.match(controlEventsText, /event: decision\.recorded/);
    assert.match(controlEventsText, /event: artifact\.restored/);
    assert.match(controlEventsText, /event: approval\.resolved/);
    const cancelled = await postJson(`${server.url}/runs/${started.run_id}/cancel`, { reason: "No-op cancel after completion." });
    assert.equal(cancelled.status, "completed");

    const planOutput = join(root, "plan-project");
    await writeFile(join(planOutput, "occupied.txt"), "busy", "utf8").catch(async () => {
      await mkdir(planOutput, { recursive: true });
      await writeFile(join(planOutput, "occupied.txt"), "busy", "utf8");
    });
    const planStarted = await postJson(`${server.url}/runs`, {
      idea: "Plan-only alias check.",
      output: planOutput,
      mode: "plan",
      offline: true,
      provider: "offline",
      run_research_pipeline: false
    });
    assert.equal(planStarted.mode, "read-only");
    assert.equal(planStarted.legacy_mode, "plan");
    await waitForFinal(server.url, String(planStarted.run_id));

    const dangerOutput = join(root, "danger-project");
    await mkdir(dangerOutput, { recursive: true });
    await writeFile(join(dangerOutput, "occupied.txt"), "busy", "utf8");
    const dangerStarted = await postJson(`${server.url}/runs`, {
      idea: "Danger alias check.",
      output: dangerOutput,
      mode: "danger-full-access",
      offline: true,
      provider: "offline",
      run_research_pipeline: false
    });
    assert.equal(dangerStarted.mode, "danger");
    assert.equal(dangerStarted.legacy_mode, "danger-full-access");
    await waitForFinal(server.url, String(dangerStarted.run_id));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function getJson(url: string): Promise<Record<string, any>> {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as Record<string, any>;
}

async function postJson(url: string, payload: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as Record<string, any>;
}

async function waitForRunResult(baseUrl: string, runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await getJson(`${baseUrl}/runs/${runId}`);
    if (run.result) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("run did not finish artifact writing before timeout");
}

async function waitForFinal(baseUrl: string, runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await getJson(`${baseUrl}/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(String(run.status))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("run did not reach a terminal state before timeout");
}
