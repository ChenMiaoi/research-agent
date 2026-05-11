import type { ApprovalRecord } from "./runtime/approvals.js";
import type { Idea2RepoEvent } from "./runtime/events.js";
import type { EvidenceItem, ScoreSnapshot } from "./runtime/ledgers.js";
import type { RuntimeRunSnapshot, RuntimeRunStatus, StageControlResult } from "./runtime/runs.js";
import type { ResearchStageId } from "./pipeline/stages.js";

export type RuntimeProductMode = "read-only" | "research" | "generate" | "publish" | "danger";
export type RuntimeLegacyMode = "plan" | "generate" | "publish" | "danger-full-access";

export type GenerateRequest = {
  idea: string;
  output: string;
  mode?: RuntimeProductMode | RuntimeLegacyMode;
  domains?: string[];
  weeks?: number;
  resources?: string[];
  stack?: "python" | "ts";
  force?: boolean;
  offline?: boolean;
  provider?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  run_research_pipeline?: boolean;
  allow_network?: boolean;
  download_pdfs?: boolean;
  max_papers?: number;
  sources?: string[];
  strict_ccf_a?: boolean;
  venue?: string;
  template?: string;
  review_mode?: "anonymous" | "camera-ready" | "non-anonymous";
  paper_type?: "full" | "short" | "demo" | "dataset" | "system" | "benchmark";
  template_year?: number;
  compile_paper?: boolean;
  package_overleaf?: boolean;
};

export type GenerateResponse = {
  root: string;
  project_name: string;
  primary_route: string | undefined;
  raw_score: number;
  revised_score: number;
  evidence_gate: Record<string, unknown>;
  security: Record<string, unknown>;
  analysis_source: string;
  codex_available: boolean;
  codex_logged_in: boolean;
  codex_model: string | null;
  fallback_reason: string;
  research_pipeline_stages?: number;
  template_profile_id?: string | null;
};

export type PathRequest = {
  output: string;
};

export type StatusResponse = {
  project_name: string;
  stage: string;
  total_artifacts: number;
  present_artifacts: number;
  missing_artifacts: string[];
  modified_artifacts: string[];
};

export type ArtifactReadRequest = {
  output: string;
  path: string;
};

export type ArtifactReadResponse = {
  path: string;
  bytes: number;
  content: string;
};

export type GithubDryRunRequest = {
  output: string;
  repo_name?: string;
  create_issues?: boolean;
};

export type RuntimeRunCreateRequest = GenerateRequest & {
  jsonl_events?: boolean;
};

export type RuntimeRunLinks = {
  mode: RuntimeProductMode;
  legacy_mode: RuntimeLegacyMode;
  events_url: string;
  event_replay_url: string;
  plan_url: string;
  decisions_url: string;
  artifacts_url: string;
  evidence_url: string;
  score_snapshots_url: string;
  approvals_url: string;
};

export type RuntimeRunCreateResponse = RuntimeRunLinks & {
  run_id: string;
  status: RuntimeRunStatus;
  output_root: string;
};

export type RuntimeRunResponse = RuntimeRunSnapshot & RuntimeRunLinks & {
  run_id: string;
};

export type RuntimeEventReplayResponse = {
  run_id: string;
  events: Idea2RepoEvent[];
};

export type RuntimeSseEvent = {
  event: Idea2RepoEvent["type"];
  data: Idea2RepoEvent;
};

export type StageControlRequest = {
  reason?: string;
  execute?: boolean;
  allow_network?: boolean;
  download_pdfs?: boolean;
  max_papers?: number;
};

export type StageSkipRequest = {
  reason: string;
};

export type StageControlResponse = StageControlResult;

export type ApprovalResolutionRequest = {
  decision: "approved" | "denied";
  reason?: string;
};

export type ApprovalResolutionResponse = ApprovalRecord;

export type RuntimeEvidenceResponse = {
  run_id: string;
  evidence: EvidenceItem[];
  current: EvidenceItem[];
};

export type RuntimeScoreSnapshotsResponse = {
  run_id: string;
  score_snapshots: ScoreSnapshot[];
};

export type ArtifactProjectionKind = "reports" | "evidence" | "plans" | "paper" | "runtime" | "other";

export type ArtifactProjection = {
  kind: ArtifactProjectionKind;
  path: string;
  bytes: number;
  text: boolean;
};

export type RuntimeArtifactsResponse = {
  run_id?: string;
  root: string;
  artifacts: ArtifactProjection[];
  projections: Record<ArtifactProjectionKind, ArtifactProjection[]>;
  tree: Record<string, unknown>;
};

export type RuntimeStageControlPath = `/runs/${string}/stages/${ResearchStageId}/${"retry" | "skip"}`;
