import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { ApprovalDialog } from "../src/tui/ApprovalDialog.js";
import { ArtifactPanel } from "../src/tui/ArtifactPanel.js";
import { PlanPanel } from "../src/tui/PlanPanel.js";
import { nextInspectorTab, ResearchCockpit } from "../src/tui/ResearchCockpit.js";
import { TracePanel } from "../src/tui/TracePanel.js";
import type { Idea2RepoEvent } from "../src/runtime/events.js";
import type { PlanState } from "../src/runtime/plan.js";
import { applyTuiRuntimeEvent, createTuiRuntimeSnapshot, liveApprovalDetails, liveDecisionDetails } from "../src/tui/runtime-view.js";

test("runtime TUI panels render as React elements", () => {
  const plan: PlanState = {
    version: 1,
    run_id: "run-1",
    updated_at: "2026-01-01T00:00:00Z",
    items: [
      {
        id: "idea_intake",
        stage_id: "idea_intake",
        step: "Idea intake",
        status: "in_progress",
        artifacts: ["docs/idea.md"],
        input_refs: ["idea"],
        output_refs: ["docs/idea.md"],
        evidence_refs: [],
        decision_ids: [],
        next_actions: ["Run Idea intake"],
        updated_at: "2026-01-01T00:00:00Z"
      }
    ]
  };
  const events: Idea2RepoEvent[] = [
    {
      type: "run.started",
      run_id: "run-1",
      idea: "test idea",
      output_root: "generated_repos/test",
      timestamp: "2026-01-01T00:00:00Z"
    }
  ];

  assert.equal(React.isValidElement(PlanPanel({ plan })), true);
  assert.equal(React.isValidElement(TracePanel({ events })), true);
  assert.equal(React.isValidElement(ArtifactPanel({ artifacts: [{ path: "docs/idea.md", bytes: 12, text: true }] })), true);
  assert.equal(React.isValidElement(ApprovalDialog({ approvalId: "approval-1", action: "publish", risk: "network", selectedDecision: "denied" })), true);
});

test("TUI runtime snapshot follows live runtime events", () => {
  let snapshot = createTuiRuntimeSnapshot("run-1", "generated_repos/demo", "2026-01-01T00:00:00Z");
  const events: Idea2RepoEvent[] = [
    {
      type: "run.started",
      run_id: "run-1",
      idea: "test idea",
      output_root: "generated_repos/demo",
      timestamp: "2026-01-01T00:00:01Z"
    },
    {
      type: "stage.started",
      run_id: "run-1",
      stage_id: "idea_intake",
      label: "Idea intake",
      timestamp: "2026-01-01T00:00:02Z"
    },
    {
      type: "artifact.written",
      run_id: "run-1",
      path: "docs/idea/idea_brief.md",
      sha256: "abc",
      bytes: 42,
      timestamp: "2026-01-01T00:00:03Z"
    },
    {
      type: "decision.recorded",
      run_id: "run-1",
      decision_id: "decision-1",
      stage_id: "idea_intake",
      title: "Accepted initial idea",
      timestamp: "2026-01-01T00:00:04Z"
    },
    {
      type: "approval.requested",
      run_id: "run-1",
      approval_id: "approval-1",
      action: "tool:github.publish",
      risk: "network, publish",
      timestamp: "2026-01-01T00:00:05Z"
    },
    {
      type: "run.completed",
      run_id: "run-1",
      timestamp: "2026-01-01T00:00:06Z"
    }
  ];

  for (const event of events) snapshot = applyTuiRuntimeEvent(snapshot, event);

  assert.equal(snapshot.events.length, events.length);
  assert.equal(snapshot.plan.items.find((item) => item.stage_id === "idea_intake")?.status, "in_progress");
  assert.deepEqual(snapshot.artifacts.map((artifact) => artifact.path), ["docs/idea/idea_brief.md"]);
  assert.match(liveDecisionDetails(snapshot).join("\n"), /Accepted initial idea/);
  assert.match(liveApprovalDetails(snapshot).join("\n"), /tool:github.publish/);
  assert.equal(snapshot.status, "completed");
});

test("research cockpit hides raw trace outside Debug inspector tab", () => {
  let snapshot = createTuiRuntimeSnapshot("run-1", "generated_repos/demo", "2026-01-01T00:00:00Z");
  const events: Idea2RepoEvent[] = [
    {
      type: "run.started",
      run_id: "run-1",
      idea: "test idea",
      output_root: "generated_repos/demo",
      timestamp: "2026-01-01T00:00:01Z"
    },
    {
      type: "paper.found",
      run_id: "run-1",
      paper_id: "paper-1",
      title: "Evidence First Agents",
      venue: "NeurIPS",
      year: 2026,
      pdf_status: "available",
      timestamp: "2026-01-01T00:00:02Z"
    },
    {
      type: "evidence.extracted",
      run_id: "run-1",
      evidence_id: "e1",
      paper_id: "paper-1",
      claim: "Uses page-level evidence",
      claim_type: "method",
      page: 4,
      quote: "quoted evidence",
      chunk_id: "paper-1-p4-c1",
      confidence: 0.8,
      timestamp: "2026-01-01T00:00:03Z"
    },
    {
      type: "score.updated",
      run_id: "run-1",
      score: 62,
      max_score: 100,
      confidence: 0.7,
      hard_blockers: ["No reproduction yet"],
      timestamp: "2026-01-01T00:00:04Z"
    }
  ];
  for (const event of events) snapshot = applyTuiRuntimeEvent(snapshot, event);

  const defaultText = textContent(ResearchCockpit({ snapshot, height: 18, width: 120, activeInspectorTab: "evidence" }));
  assert.match(defaultText, /PLAN/);
  assert.match(defaultText, /RESEARCH THREAD/);
  assert.match(defaultText, /INSPECTOR/);
  assert.match(defaultText, /Evidence/);
  assert.match(defaultText, /Papers/);
  assert.match(defaultText, /Score/);
  assert.match(defaultText, /Artifacts/);
  assert.match(defaultText, /Approvals/);
  assert.match(defaultText, /Debug/);
  assert.match(defaultText, /Uses page-level evidence/);
  assert.doesNotMatch(defaultText, /run\.started/);
  assert.doesNotMatch(defaultText, /Trace/);

  const debugText = textContent(ResearchCockpit({ snapshot, height: 18, width: 120, activeInspectorTab: "debug" }));
  assert.match(debugText, /Debug/);
  assert.match(debugText, /run\.started/);
  assert.equal(nextInspectorTab("evidence", 1), "papers");
  assert.equal(nextInspectorTab("evidence", -1), "debug");
});

test("TUI runtime snapshot surfaces blocked stage state", () => {
  let snapshot = createTuiRuntimeSnapshot("run-1", "generated_repos/demo", "2026-01-01T00:00:00Z");
  snapshot = applyTuiRuntimeEvent(snapshot, {
    type: "stage.blocked",
    run_id: "run-1",
    stage_id: "pdf_acquisition",
    reason: "Pending PDF approval",
    timestamp: "2026-01-01T00:00:01Z"
  });
  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.message, "Pending PDF approval");
  snapshot = applyTuiRuntimeEvent(snapshot, {
    type: "stage.started",
    run_id: "run-1",
    stage_id: "pdf_acquisition",
    label: "PDF acquisition",
    timestamp: "2026-01-01T00:00:02Z"
  });
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.message, undefined);
});

function textContent(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (React.isValidElement(value)) {
    const element = value as React.ReactElement<{ children?: React.ReactNode }>;
    if (typeof element.type === "function") return textContent((element.type as (props: { children?: React.ReactNode }) => React.ReactNode)(element.props));
    return textContent(element.props.children);
  }
  return "";
}
