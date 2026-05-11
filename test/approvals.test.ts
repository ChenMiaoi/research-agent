import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGithubExportPlan, publishWithGh, type CommandRunner } from "../src/github-export.js";
import { generateResearchRepo } from "../src/generator.js";
import {
  ApprovalRecorder,
  ApprovalRequiredError,
  approvalDecision,
  approvalPolicyForMode,
  enforceApproval,
  readApprovalRecords
} from "../src/runtime/approvals.js";
import { readJsonlEvents } from "../src/runtime/events.js";

test("approval policy gates network publish and overwrite risks by runtime mode", () => {
  const plan = approvalPolicyForMode("plan");
  assert.equal(approvalDecision(plan, ["read"]), "auto_approved");
  assert.equal(approvalDecision(plan, ["write"]), "denied");
  assert.equal(approvalDecision(plan, ["network"]), "requires_approval");
  assert.equal(approvalDecision(plan, ["publish"]), "denied");

  const generate = approvalPolicyForMode("generate");
  assert.equal(approvalDecision(generate, ["write"]), "auto_approved");
  assert.equal(approvalDecision(generate, ["overwrite"]), "requires_approval");
  assert.equal(approvalDecision(generate, ["publish"]), "denied");

  const publish = approvalPolicyForMode("publish");
  assert.equal(approvalDecision(publish, ["publish"]), "requires_approval");
  assert.equal(approvalDecision(approvalPolicyForMode("publish", { allowPublish: true, allowNetwork: true }), ["network", "publish"]), "auto_approved");
  assert.equal(approvalDecision(approvalPolicyForMode("danger-full-access"), ["shell"]), "denied");
});

test("approval recorder persists requested denied and auto-approved decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-approvals-"));
  try {
    const policy = approvalPolicyForMode("publish");
    const recorder = new ApprovalRecorder(root, policy);
    await assert.rejects(
      enforceApproval(
        policy,
        {
          run_id: "run-1",
          action: "GitHub export publish",
          risk: ["publish"]
        },
        recorder
      ),
      ApprovalRequiredError
    );

    await enforceApproval(
      approvalPolicyForMode("publish", { allowPublish: true, allowNetwork: true }),
      {
        run_id: "run-1",
        action: "GitHub export publish",
        risk: ["network", "publish"]
      },
      new ApprovalRecorder(root, approvalPolicyForMode("publish", { allowPublish: true, allowNetwork: true }))
    );

    const records = await readApprovalRecords(root);
    assert.deepEqual(
      records.map((record) => record.status),
      ["pending", "denied", "auto_approved"]
    );
    assert.equal(records[0]?.action, "GitHub export publish");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("github publish refuses without approval and records the denied request", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-github-approval-"));
  const output = join(root, "project");
  const commands: string[][] = [];
  const runner: CommandRunner = async (command) => {
    commands.push(command);
  };
  try {
    await mkdir(join(output, "docs", "execution_plan"), { recursive: true });
    await writeFile(join(output, "docs", "execution_plan", "todo.md"), "- Verify publish approval gate.\n", "utf8");
    const plan = await buildGithubExportPlan(output);

    await assert.rejects(
      publishWithGh(plan, {
        permissionPolicy: {
          allowWrite: true,
          allowOverwrite: false,
          allowNetwork: false,
          allowLogin: false,
          allowInstall: false,
          allowPublish: false
        },
        runner
      }),
      ApprovalRequiredError
    );

    assert.equal(commands.length, 0);
    const records = await readApprovalRecords(output);
    assert.deepEqual(
      records.map((record) => record.status),
      ["pending", "denied"]
    );
    assert.deepEqual(records.at(-1)?.risk, ["write", "network", "publish"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation wires approval recorder into runtime tool execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-generate-approval-"));
  const output = join(root, "project");
  try {
    await generateResearchRepo("A local-first research agent with approval traceability.", output, {
      offline: true,
      provider: "offline",
      jsonlEvents: true
    });

    const records = await readApprovalRecords(output);
    assert.ok(records.some((record) => record.action === "tool:artifact.write" && record.status === "auto_approved"));
    const events = await readJsonlEvents(join(output, ".idea2repo", "trace.jsonl"));
    assert.ok(events.some((event) => event.type === "approval.resolved"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
