import type {
  RuntimeApproval,
  RuntimeArtifact,
  RuntimeDecision,
  RuntimeEvent,
  RuntimeRunSummary,
  RuntimeViewState
} from "./types";

const MAX_EVENTS = 200;

export function createRuntimeView(run: { run_id: string; output_root: string; status: RuntimeRunSummary["status"] }): RuntimeViewState {
  return {
    runId: run.run_id,
    outputRoot: run.output_root,
    status: run.status,
    connected: true,
    events: [],
    plan: [],
    artifacts: [],
    decisions: [],
    approvals: []
  };
}

export function applyRuntimeEvent(state: RuntimeViewState, event: RuntimeEvent): RuntimeViewState {
  if (event.run_id !== state.runId) return state;
  return {
    ...state,
    events: [...state.events, event].slice(-MAX_EVENTS),
    status: statusForEvent(state.status, event),
    error: event.type === "run.failed" ? event.error : state.error,
    plan: planForEvent(state.plan, event),
    artifacts: artifactsForEvent(state.artifacts, event),
    decisions: decisionsForEvent(state.decisions, event),
    approvals: approvalsForEvent(state.approvals, event)
  };
}

export function disconnectRuntimeView(state: RuntimeViewState, error?: string): RuntimeViewState {
  return { ...state, connected: false, error: error ?? state.error };
}

function statusForEvent(current: RuntimeRunSummary["status"], event: RuntimeEvent): RuntimeRunSummary["status"] {
  if (event.type === "run.started") return "running";
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.failed") return "failed";
  if (event.type === "run.cancelled") return "cancelled";
  if (event.type === "stage.blocked") return "blocked";
  if (event.type === "stage.started" && current === "blocked") return "running";
  return current;
}

function planForEvent(plan: RuntimeViewState["plan"], event: RuntimeEvent): RuntimeViewState["plan"] {
  if (event.type === "plan.updated") return event.plan.map((item) => ({ ...item }));
  return plan;
}

function artifactsForEvent(artifacts: RuntimeArtifact[], event: RuntimeEvent): RuntimeArtifact[] {
  if (event.type !== "artifact.written") return artifacts;
  const next = { path: event.path, bytes: event.bytes, text: isTextArtifact(event.path) };
  return [...artifacts.filter((artifact) => artifact.path !== next.path), next].sort((left, right) => left.path.localeCompare(right.path));
}

function decisionsForEvent(decisions: RuntimeDecision[], event: RuntimeEvent): RuntimeDecision[] {
  if (event.type !== "decision.recorded") return decisions;
  const next = {
    id: event.decision_id,
    title: event.title,
    stage_id: event.stage_id,
    timestamp: event.timestamp
  };
  return [...decisions.filter((decision) => decision.id !== next.id), next];
}

function approvalsForEvent(approvals: RuntimeApproval[], event: RuntimeEvent): RuntimeApproval[] {
  if (event.type === "approval.requested") {
    const next = {
      id: event.approval_id,
      action: event.action,
      risk: event.risk,
      stage_id: event.stage_id,
      timestamp: event.timestamp
    };
    return [...approvals.filter((approval) => approval.id !== next.id), next];
  }
  if (event.type !== "approval.resolved") return approvals;
  const existing = approvals.find((approval) => approval.id === event.approval_id);
  const next = {
    id: event.approval_id,
    action: existing?.action ?? event.approval_id,
    risk: existing?.risk,
    decision: event.decision,
    timestamp: event.timestamp
  };
  return [...approvals.filter((approval) => approval.id !== next.id), next];
}

function isTextArtifact(path: string): boolean {
  return /\.(?:csv|json|jsonl|md|py|ts|tsx|txt|ya?ml)$/i.test(path);
}
