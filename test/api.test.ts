import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startApiServer } from "../src/api.js";

test("Node API preserves health, generate, status, validate, artifact read, and GitHub dry-run contract", async () => {
  const server = await startApiServer({ port: 0 });
  const root = await mkdtemp(join(tmpdir(), "idea2repo-api-"));
  const output = join(root, "project");
  try {
    const health = await getJson(`${server.url}/health`);
    assert.equal(health.ok, true);
    assert.equal(health.runtime, "node");

    const generated = await postJson(`${server.url}/generate`, {
      idea: "A defensive security benchmark with threat model, baselines, datasets, metrics, and recent related work.",
      output,
      domains: ["security"],
      offline: true,
      provider: "offline",
      weeks: 8,
      force: false
    });
    assert.equal(generated.analysis_source, "offline_fallback");
    assert.equal(generated.primary_route, "security");

    const status = await postJson(`${server.url}/status`, { output });
    assert.equal(status.missing_artifacts.length, 0);

    const validation = await postJson(`${server.url}/validate`, { output });
    assert.equal(validation.ok, true);

    const artifact = await postJson(`${server.url}/artifacts/read`, {
      output,
      path: "docs/diagnosis/ccf_a_readiness_report.md"
    });
    assert.match(artifact.content, /CCF-A Readiness Report/);

    const artifacts = await postJson(`${server.url}/artifacts`, { output });
    assert.ok(Array.isArray(artifacts.artifacts));
    assert.ok(artifacts.artifacts.some((entry: { path: string }) => entry.path === "docs/diagnosis/ccf_a_readiness_report.md"));
    assert.ok(artifacts.tree.docs);
    assert.ok(Array.isArray(artifacts.projections.reports));
    assert.ok(artifacts.projections.reports.some((entry: { path: string }) => entry.path === "docs/diagnosis/ccf_a_readiness_report.md"));

    const dryRun = await postJson(`${server.url}/github/dry-run`, { output });
    assert.equal(dryRun.dry_run, true);
    assert.ok(dryRun.would_create_issues > 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
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
