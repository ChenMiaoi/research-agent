import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { generateResearchRepo } from "../src/generator.js";
import { ApprovalRecorder, ApprovalRequiredError, approvalPolicyForMode, readApprovalRecords } from "../src/runtime/approvals.js";
import { EventBus, type Idea2RepoEvent } from "../src/runtime/events.js";
import { createCoreToolRegistry, createToolContext, readToolCallRecords } from "../src/runtime/tools.js";

test("core tool registry exposes plan-required tool names", () => {
  const names = createCoreToolRegistry().list().map((tool) => tool.name);
  for (const toolName of ["ccf_a.score", "template.resolve", "template.render", "template.check"]) {
    assert.ok(names.includes(toolName), `missing ${toolName}`);
  }
});

test("core tool registry logs artifact calls and emits runtime events", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-tools-"));
  const events: Idea2RepoEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  const registry = createCoreToolRegistry();
  const ctx = createToolContext({
    runId: "run-tools",
    outputRoot: root,
    events: bus,
    permissions: approvalPolicyForMode("generate")
  });
  try {
    await registry.execute("artifact.write", { path: "docs/a.md", content: "# A\n" }, ctx);
    const read = await registry.execute<{ path: string }, { path: string; content: string; bytes: number }>("artifact.read", { path: "docs/a.md" }, ctx);

    assert.equal(read.content, "# A\n");
    assert.deepEqual(
      events.map((event) => event.type),
      ["tool.started", "artifact.snapshot", "artifact.written", "tool.completed", "tool.started", "tool.completed"]
    );
    const records = await readToolCallRecords(root);
    assert.deepEqual(
      records.map((record) => `${record.tool_name}:${record.status}`),
      ["artifact.write:started", "artifact.write:completed", "artifact.read:started", "artifact.read:completed"]
    );
    assert.match(records[0]?.input_summary ?? "", /path=docs\/a.md/);
    assert.doesNotMatch(JSON.stringify(records), /# A/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool registry gates GitHub publish and records denied approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-tools-publish-"));
  const registry = createCoreToolRegistry();
  const policy = approvalPolicyForMode("publish");
  const ctx = createToolContext({
    runId: "run-publish",
    outputRoot: root,
    permissions: policy,
    approvals: new ApprovalRecorder(root, policy)
  });
  try {
    await mkdir(join(root, "docs", "execution_plan"), { recursive: true });
    await writeFile(join(root, "docs", "execution_plan", "todo.md"), "- Verify registry publish gate.\n", "utf8");
    await assert.rejects(registry.execute("github.publish", { repoName: "demo" }, ctx), ApprovalRequiredError);

    const calls = await readToolCallRecords(root);
    assert.deepEqual(
      calls.map((record) => `${record.tool_name}:${record.status}`),
      ["github.publish:started", "github.publish:failed"]
    );
    const approvals = await readApprovalRecords(root);
    assert.deepEqual(
      approvals.map((record) => record.status),
      ["pending", "denied"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline generation persists artifact tool call records", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-tools-generate-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("A local-first research agent benchmark with baseline dataset and metric.", output, {
      offline: true,
      provider: "offline"
    });
    const calls = await readToolCallRecords(output);
    assert.ok(calls.some((record) => record.tool_name === "artifact.write" && record.status === "completed"));
    assert.ok(calls.some((record) => /docs\/diagnosis\/ccf_a_readiness_report.md/.test(record.input_summary)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research generation adopts package helper artifacts into tool records", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-tools-package-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("A local-first research agent benchmark with baseline dataset and metric.", output, {
      offline: true,
      provider: "offline",
      runResearchPipeline: true,
      jsonlEvents: true
    });
    const calls = await readToolCallRecords(output);
    for (const toolName of ["literature.search", "pdf.acquire", "pdf.chunk", "evidence.extract", "ccf_a.score", "template.resolve", "template.render", "template.check"]) {
      assert.ok(calls.some((record) => record.tool_name === toolName && record.status === "completed"), `missing completed ${toolName}`);
    }
    assert.ok(calls.some((record) => record.tool_name === "artifact.adopt" && /paper\/submission\/overleaf.zip/.test(record.input_summary)));
    assert.ok(calls.some((record) => record.tool_name === "artifact.adopt" && /paper\/submission\/submission.zip/.test(record.input_summary)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact.adopt records helper-generated compile PDFs", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-tools-adopt-pdf-"));
  const registry = createCoreToolRegistry();
  const ctx = createToolContext({
    runId: "run-adopt-pdf",
    outputRoot: root,
    permissions: approvalPolicyForMode("generate")
  });
  try {
    const pdfPath = join(root, "paper", "build", "main.pdf");
    await mkdir(dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, Buffer.from("%PDF-1.4\n"));
    await registry.execute("artifact.adopt", {
      path: "paper/build/main.pdf",
      bytes: Buffer.byteLength("%PDF-1.4\n"),
      sha256: "pdf-digest"
    }, ctx);

    const calls = await readToolCallRecords(root);
    assert.ok(calls.some((record) => record.tool_name === "artifact.adopt" && /paper\/build\/main.pdf/.test(record.input_summary)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
