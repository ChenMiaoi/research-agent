import type { Idea2RepoEvent } from "../runtime/events.js";
import { createPlanState, updatePlanForStageEvent, type PlanState } from "../runtime/plan.js";
import type { RuntimeArtifactEntry } from "./ArtifactPanel.js";

export type TuiRuntimeDecision = {
  id: string;
  title: string;
  stage_id?: string;
  timestamp: string;
};

export type TuiRuntimeApproval = {
  id: string;
  action: string;
  stage_id?: string;
  risk?: string;
  decision?: "approved" | "denied";
  timestamp: string;
};

export type TuiRuntimeSnapshot = {
  runId: string;
  outputRoot: string;
  plan: PlanState;
  events: Idea2RepoEvent[];
  artifacts: RuntimeArtifactEntry[];
  decisions: TuiRuntimeDecision[];
  approvals: TuiRuntimeApproval[];
  status: "running" | "blocked" | "completed" | "failed" | "cancelled";
  message?: string;
};

const MAX_LIVE_EVENTS = 200;

export function createTuiRuntimeSnapshot(runId: string, outputRoot: string, timestamp?: string): TuiRuntimeSnapshot {
  return {
    runId,
    outputRoot,
    plan: createPlanState(runId, timestamp),
    events: [],
    artifacts: [],
    decisions: [],
    approvals: [],
    status: "running"
  };
}

export function applyTuiRuntimeEvent(snapshot: TuiRuntimeSnapshot, event: Idea2RepoEvent): TuiRuntimeSnapshot {
  if (event.run_id !== snapshot.runId) return snapshot;
  const events = [...snapshot.events, event].slice(-MAX_LIVE_EVENTS);
  return {
    ...snapshot,
    events,
    plan: planForRuntimeEvent(snapshot.plan, event),
    artifacts: artifactsForRuntimeEvent(snapshot.artifacts, event),
    decisions: decisionsForRuntimeEvent(snapshot.decisions, event),
    approvals: approvalsForRuntimeEvent(snapshot.approvals, event),
    ...statusForRuntimeEvent(snapshot.status, event)
  };
}

export function liveDecisionDetails(snapshot: TuiRuntimeSnapshot, limit = 8): string[] {
  return snapshot.decisions.slice(-limit).map((decision) => `${decision.timestamp} ${decision.title}${decision.stage_id ? ` (${decision.stage_id})` : ""}`);
}

export function liveApprovalDetails(snapshot: TuiRuntimeSnapshot, limit = 8): string[] {
  return snapshot.approvals.slice(-limit).map((approval) => {
    const suffix = approval.decision ? ` -> ${approval.decision}` : approval.risk ? ` [${approval.risk}]` : "";
    return `${approval.timestamp} ${approval.action}${suffix}`;
  });
}

function planForRuntimeEvent(plan: PlanState, event: Idea2RepoEvent): PlanState {
  if (event.type === "plan.updated") {
    return {
      version: 1,
      run_id: event.run_id,
      updated_at: event.timestamp,
      items: event.plan.map((item) => ({ ...item }))
    };
  }
  if (isStageRuntimeEvent(event)) return updatePlanForStageEvent(plan, event);
  return plan;
}

function artifactsForRuntimeEvent(artifacts: RuntimeArtifactEntry[], event: Idea2RepoEvent): RuntimeArtifactEntry[] {
  if (event.type !== "artifact.written") return artifacts;
  const next: RuntimeArtifactEntry = {
    path: event.path,
    bytes: event.bytes,
    text: isTextRuntimeArtifact(event.path)
  };
  const remaining = artifacts.filter((artifact) => artifact.path !== event.path);
  return [...remaining, next].sort((left, right) => left.path.localeCompare(right.path));
}

function decisionsForRuntimeEvent(decisions: TuiRuntimeDecision[], event: Idea2RepoEvent): TuiRuntimeDecision[] {
  if (event.type !== "decision.recorded") return decisions;
  const next: TuiRuntimeDecision = {
    id: event.decision_id,
    title: event.title,
    stage_id: event.stage_id,
    timestamp: event.timestamp
  };
  return [...decisions.filter((decision) => decision.id !== next.id), next];
}

function approvalsForRuntimeEvent(approvals: TuiRuntimeApproval[], event: Idea2RepoEvent): TuiRuntimeApproval[] {
  if (event.type === "approval.requested") {
    const next: TuiRuntimeApproval = {
      id: event.approval_id,
      action: event.action,
      stage_id: event.stage_id,
      risk: event.risk,
      timestamp: event.timestamp
    };
    return [...approvals.filter((approval) => approval.id !== next.id), next];
  }
  if (event.type !== "approval.resolved") return approvals;
  const existing = approvals.find((approval) => approval.id === event.approval_id);
  const next: TuiRuntimeApproval = {
    id: event.approval_id,
    action: existing?.action ?? event.approval_id,
    stage_id: existing?.stage_id,
    risk: existing?.risk,
    decision: event.decision,
    timestamp: event.timestamp
  };
  return [...approvals.filter((approval) => approval.id !== next.id), next];
}

function statusForRuntimeEvent(current: TuiRuntimeSnapshot["status"], event: Idea2RepoEvent): Partial<Pick<TuiRuntimeSnapshot, "status" | "message">> {
  if (event.type === "run.completed") return { status: "completed", message: undefined };
  if (event.type === "run.failed") return { status: "failed", message: event.error };
  if (event.type === "run.cancelled") return { status: "cancelled", message: event.reason };
  if (event.type === "stage.blocked") return { status: "blocked", message: event.reason };
  if (event.type === "stage.started" && current === "blocked") return { status: "running", message: undefined };
  return {};
}

function isStageRuntimeEvent(event: Idea2RepoEvent): event is Extract<Idea2RepoEvent, { stage_id: string }> {
  return event.type === "stage.started" || event.type === "stage.completed" || event.type === "stage.skipped" || event.type === "stage.failed" || event.type === "stage.blocked";
}

function isTextRuntimeArtifact(path: string): boolean {
  return /\.(?:csv|json|jsonl|md|py|ts|tsx|txt|ya?ml)$/i.test(path);
}
