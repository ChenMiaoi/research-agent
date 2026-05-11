import type { LucideIcon } from "lucide-react";

export type RuntimePlanItem = {
  id: string;
  stage_id?: string;
  step: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "skipped";
  blocker?: string;
  artifacts: string[];
  input_refs: string[];
  output_refs: string[];
  evidence_refs: string[];
  decision_ids: string[];
  next_actions: string[];
  updated_at: string;
};

export type RouteScore = {
  id: string;
  route: string;
  score: number;
  gate: "ready" | "blocked" | "warning";
  feasible: number;
  novelty: number;
  impact: number;
  progress: number;
};

export type LiteratureRecord = {
  id: string;
  citation: string;
  finding: string;
  relevance: number;
  evidence: "high" | "medium" | "low";
  selected: boolean;
};

export type BoardColumn = {
  title: string;
  tone: "plan" | "active" | "validate" | "done" | "blocked";
  tasks: string[];
};

export type ArtifactNode = {
  path: string;
  status: "clean" | "modified" | "missing";
  depth: number;
};

export type ProviderService = {
  name: string;
  status: "running" | "offline";
  detail: string;
};

export type PermissionKey =
  | "localFirst"
  | "write"
  | "network"
  | "install"
  | "publish";

export type PermissionState = Record<PermissionKey, boolean>;

export type RunLogEntry = {
  time: string;
  label: string;
  tone: "ok" | "warn" | "blocked";
};

export type NavItem = {
  label: string;
  icon: LucideIcon;
};

export type RuntimeEvent =
  | { type: "run.started"; run_id: string; idea: string; output_root: string; timestamp: string }
  | { type: "run.completed"; run_id: string; timestamp: string }
  | { type: "run.failed"; run_id: string; error: string; timestamp: string }
  | { type: "run.cancelled"; run_id: string; reason?: string; timestamp: string }
  | { type: "stage.started"; run_id: string; stage_id: string; label: string; timestamp: string }
  | { type: "stage.completed"; run_id: string; stage_id: string; artifacts: string[]; timestamp: string }
  | { type: "stage.skipped"; run_id: string; stage_id: string; reason: string; timestamp: string }
  | { type: "stage.failed"; run_id: string; stage_id: string; error: string; timestamp: string }
  | { type: "stage.blocked"; run_id: string; stage_id: string; reason: string; timestamp: string }
  | { type: "plan.updated"; run_id: string; plan: RuntimePlanItem[]; timestamp: string }
  | { type: "decision.recorded"; run_id: string; decision_id: string; stage_id?: string; title: string; timestamp: string }
  | { type: "artifact.written"; run_id: string; path: string; sha256: string; bytes: number; timestamp: string }
  | { type: "artifact.snapshot"; run_id: string; snapshot_id: string; path: string; timestamp: string }
  | { type: "artifact.restored"; run_id: string; snapshot_id: string; path: string; timestamp: string }
  | { type: "tool.started"; run_id: string; tool_call_id: string; tool_name: string; timestamp: string }
  | { type: "tool.completed"; run_id: string; tool_call_id: string; success: boolean; summary: string; timestamp: string }
  | { type: "approval.requested"; run_id: string; approval_id: string; stage_id?: string; action: string; risk: string; timestamp: string }
  | { type: "approval.resolved"; run_id: string; approval_id: string; decision: "approved" | "denied"; timestamp: string };

export type RuntimeArtifact = {
  path: string;
  bytes: number;
  text: boolean;
};

export type RuntimeDecision = {
  id: string;
  title: string;
  stage_id?: string;
  timestamp: string;
};

export type RuntimeApproval = {
  id: string;
  action: string;
  stage_id?: string;
  risk?: string;
  decision?: "approved" | "denied";
  timestamp: string;
};

export type RuntimeRunSummary = {
  id: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  idea: string;
  output_root: string;
  created_at: string;
  updated_at: string;
};

export type RuntimeViewState = {
  runId: string;
  outputRoot: string;
  status: RuntimeRunSummary["status"];
  connected: boolean;
  events: RuntimeEvent[];
  plan: RuntimePlanItem[];
  artifacts: RuntimeArtifact[];
  decisions: RuntimeDecision[];
  approvals: RuntimeApproval[];
  error?: string;
};
