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

export type TuiRuntimeResearchSummary = {
  optimizedIdea?: string;
  currentScore?: {
    score: number;
    maxScore: number;
    confidence: number;
  };
  fatalBlockers: string[];
  paperStats: {
    found: number;
    ccfA: number;
    mainTrack: number;
    downloaded: number;
    verifiedEvidence: number;
  };
  reviewerStats: {
    reviewers: number;
    openTasks: number;
    resolvedTasks: number;
  };
  nextUserAction: string;
};

export type TuiRuntimeSnapshot = {
  runId: string;
  outputRoot: string;
  plan: PlanState;
  events: Idea2RepoEvent[];
  artifacts: RuntimeArtifactEntry[];
  decisions: TuiRuntimeDecision[];
  approvals: TuiRuntimeApproval[];
  researchSummary: TuiRuntimeResearchSummary;
  status: "running" | "blocked" | "completed" | "failed" | "cancelled";
  message?: string;
};

const MAX_LIVE_EVENTS = 200;

export function createTuiRuntimeSnapshot(runId: string, outputRoot: string, timestamp?: string): TuiRuntimeSnapshot {
  const snapshot: Omit<TuiRuntimeSnapshot, "researchSummary"> = {
    runId,
    outputRoot,
    plan: createPlanState(runId, timestamp),
    events: [],
    artifacts: [],
    decisions: [],
    approvals: [],
    status: "running"
  };
  return {
    ...snapshot,
    researchSummary: researchSummaryFor({
      ...snapshot,
      researchSummary: emptyResearchSummary()
    })
  };
}

export function applyTuiRuntimeEvent(snapshot: TuiRuntimeSnapshot, event: Idea2RepoEvent): TuiRuntimeSnapshot {
  if (event.run_id !== snapshot.runId) return snapshot;
  const events = [...snapshot.events, event].slice(-MAX_LIVE_EVENTS);
  const next = {
    ...snapshot,
    events,
    plan: planForRuntimeEvent(snapshot.plan, event),
    artifacts: artifactsForRuntimeEvent(snapshot.artifacts, event),
    decisions: decisionsForRuntimeEvent(snapshot.decisions, event),
    approvals: approvalsForRuntimeEvent(snapshot.approvals, event),
    ...statusForRuntimeEvent(snapshot.status, event)
  };
  return {
    ...next,
    researchSummary: researchSummaryFor(next)
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

function researchSummaryFor(snapshot: TuiRuntimeSnapshot): TuiRuntimeResearchSummary {
  const score = [...snapshot.events].reverse().find((event): event is Extract<Idea2RepoEvent, { type: "score.updated" }> => event.type === "score.updated");
  const paperEvents = snapshot.events.filter((event): event is Extract<Idea2RepoEvent, { type: "paper.found" }> => event.type === "paper.found");
  const downloaded = new Set(snapshot.events.filter((event) => event.type === "pdf.downloaded").map((event) => event.paper_id));
  const evidencePapers = new Set(snapshot.events.filter((event) => event.type === "evidence.extracted").map((event) => event.paper_id));
  const papersById = new Map<string, Extract<Idea2RepoEvent, { type: "paper.found" }>>();
  for (const event of paperEvents) papersById.set(event.paper_id, event);
  const papers = [...papersById.values()];
  const pendingApproval = snapshot.approvals.find((approval) => !approval.decision);
  const blockedStage = snapshot.plan.items.find((item) => item.status === "blocked");
  const activeStage = snapshot.plan.items.find((item) => item.status === "in_progress");
  const latestQuestion = [...snapshot.events].reverse().find((event): event is Extract<Idea2RepoEvent, { type: "question.asked" }> => event.type === "question.asked");
  const reviewerArtifacts = new Set(
    snapshot.artifacts
      .map((artifact) => artifact.path)
      .filter((path) => /^docs\/diagnosis\/reviewer_[123]\.md$/i.test(path.replace(/\\/g, "/")))
  );
  const rebuttalArtifactPresent = snapshot.artifacts.some((artifact) => /docs\/diagnosis\/rebuttal_tasks\.md$/i.test(artifact.path.replace(/\\/g, "/")));
  const optimizedPath = snapshot.artifacts.find((artifact) => /docs\/idea\/optimized_research_direction\.md$/i.test(artifact.path.replace(/\\/g, "/")))?.path;
  return {
    optimizedIdea: optimizedPath ? `Artifact: ${optimizedPath}` : undefined,
    currentScore: score ? { score: score.score, maxScore: score.max_score, confidence: score.confidence } : undefined,
    fatalBlockers: score?.hard_blockers ?? [],
    paperStats: {
      found: papers.length,
      ccfA: papers.filter((paper) => paper.ccf_rank === "A").length,
      mainTrack: papers.filter((paper) => paper.track_status === "main_conference" || paper.track_status === "journal").length,
      downloaded: downloaded.size,
      verifiedEvidence: evidencePapers.size
    },
    reviewerStats: {
      reviewers: reviewerArtifacts.size,
      openTasks: rebuttalArtifactPresent ? 1 : 0,
      resolvedTasks: 0
    },
    nextUserAction: nextUserActionFor({ snapshot, pendingApproval, blockedStage, activeStage, latestQuestion, score })
  };
}

function emptyResearchSummary(): TuiRuntimeResearchSummary {
  return {
    fatalBlockers: [],
    paperStats: { found: 0, ccfA: 0, mainTrack: 0, downloaded: 0, verifiedEvidence: 0 },
    reviewerStats: { reviewers: 0, openTasks: 0, resolvedTasks: 0 },
    nextUserAction: "Submit an idea or wait for the next research event."
  };
}

function nextUserActionFor(input: {
  snapshot: TuiRuntimeSnapshot;
  pendingApproval?: TuiRuntimeApproval;
  blockedStage?: TuiRuntimeSnapshot["plan"]["items"][number];
  activeStage?: TuiRuntimeSnapshot["plan"]["items"][number];
  latestQuestion?: Extract<Idea2RepoEvent, { type: "question.asked" }>;
  score?: Extract<Idea2RepoEvent, { type: "score.updated" }>;
}): string {
  if (input.pendingApproval) return `Approve or deny ${input.pendingApproval.action}.`;
  if (input.blockedStage) return `Resolve blocker for ${input.blockedStage.stage_id ?? input.blockedStage.id}.`;
  if (input.latestQuestion) return `Answer: ${input.latestQuestion.question}`;
  if (input.score?.hard_blockers.length) return `Work the top blocker: ${input.score.hard_blockers[0]}.`;
  if (input.activeStage) return input.activeStage.next_actions[0] ?? `Wait for ${input.activeStage.stage_id ?? input.activeStage.id}.`;
  if (input.snapshot.status === "completed") return "Review generated reports, score, and reviewer tasks.";
  if (input.snapshot.status === "failed") return "Open Debug and retry the failed stage after fixing the error.";
  return "Wait for the next research event.";
}

function isStageRuntimeEvent(event: Idea2RepoEvent): event is Extract<Idea2RepoEvent, { stage_id: string }> {
  return event.type === "stage.started" || event.type === "stage.completed" || event.type === "stage.skipped" || event.type === "stage.failed" || event.type === "stage.blocked";
}

function isTextRuntimeArtifact(path: string): boolean {
  return /\.(?:csv|json|jsonl|md|py|ts|tsx|txt|ya?ml)$/i.test(path);
}
