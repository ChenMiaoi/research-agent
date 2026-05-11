import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startApiServer } from "../src/api.js";
import { ApprovalRecorder, approvalPolicyForMode } from "../src/runtime/approvals.js";
import { listArtifactSnapshots } from "../src/runtime/artifacts.js";
import { readJsonlEvents } from "../src/runtime/events.js";

test("runtime API starts runs and streams shared runtime events over SSE", async () => {
  const server = await startApiServer({ port: 0 });
  const root = await mkdtemp(join(tmpdir(), "idea2repo-api-sse-"));
  const output = join(root, "project");
  try {
    const started = await postJson(`${server.url}/runs`, {
      idea: "A local-first agent runtime with evidence-gated literature review and live plan updates.",
      output,
      offline: true,
      provider: "offline",
      run_research_pipeline: true,
      force: false
    });
    assert.equal(started.status, "queued");
    assert.equal(typeof started.run_id, "string");

    const eventsResponse = await fetch(`${server.url}/runs/${started.run_id}/events`);
    const eventsText = await eventsResponse.text();
    assert.equal(eventsResponse.ok, true, eventsText);
    assert.match(eventsText, /event: run\.started/);
    assert.match(eventsText, /event: stage\.started/);
    assert.match(eventsText, /event: plan\.updated/);
    assert.match(eventsText, /event: artifact\.written/);
    assert.match(eventsText, /event: run\.completed/);
    assert.ok(eventsText.indexOf("event: artifact.written") < eventsText.lastIndexOf("event: run.completed"));

    const run = await getJson(`${server.url}/runs/${started.run_id}`);
    assert.equal(run.status, "completed");
    assert.ok(Number(run.event_count) > 0);
    await waitForRunResult(server.url, String(started.run_id));

    const plan = await getJson(`${server.url}/runs/${started.run_id}/plan`);
    assert.equal(plan.plan.version, 1);
    assert.ok(Array.isArray(plan.plan.items));

    const decisions = await getJson(`${server.url}/runs/${started.run_id}/decisions`);
    assert.ok(Array.isArray(decisions.decisions));
    assert.ok(decisions.decisions.length > 0);

    const artifacts = await getJson(`${server.url}/runs/${started.run_id}/artifacts`);
    assert.ok(Array.isArray(artifacts.artifacts));
    assert.ok(artifacts.artifacts.some((entry: { path: string }) => entry.path === ".idea2repo/trace.jsonl"));

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
