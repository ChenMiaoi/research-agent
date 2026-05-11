import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runResearchPipeline } from "../pipeline/research-pipeline.js";
import { createResearchPipelineState, markStage, readResearchPipelineState, updateStageRefs, writeResearchPipelineState, type ResearchPipelineState } from "../pipeline/stage-state.js";
import { researchStages, stageDefinition, type ResearchStageId } from "../pipeline/stages.js";
import { ensureChild, exists, readManifest, status as projectStatus } from "../state.js";
import { APPROVALS_PATH, approvalPolicyFromPermissions, readApprovalRecords } from "./approvals.js";
import { DecisionRecorder } from "./decisions.js";
import { readPlanState, writePlanState, type PlanState } from "./plan.js";
import { readRuntimeRunContext } from "./run-context.js";
import { JsonlEventSink, EventBus, readJsonlEvents, runtimeTimestamp, type EventSink, type EventListener, type Idea2RepoEvent } from "./events.js";
import { refreshManifestArtifactHashes, snapshotArtifact, type ArtifactSnapshotRecord } from "./artifacts.js";
import { createRunState, writeRunState, type RuntimeRunStatus } from "./run-state.js";

export type { RuntimeRunStatus } from "./run-state.js";

export type RuntimeRunSnapshot = {
  id: string;
  idea: string;
  output_root: string;
  status: RuntimeRunStatus;
  created_at: string;
  updated_at: string;
  event_count: number;
  result?: unknown;
  error?: string;
};

export type RunJobContext = {
  runId: string;
  events: EventSink;
  signal: AbortSignal;
};

export type RuntimeRunRecord = RuntimeRunSnapshot & {
  events: Idea2RepoEvent[];
};

type ManagedRun = RuntimeRunRecord & {
  bus: EventBus;
  controller: AbortController;
  finalEventSeen: boolean;
  promise: Promise<void>;
};

export class RunManager {
  private readonly runs = new Map<string, ManagedRun>();

  start(
    input: { idea: string; outputRoot: string; runId?: string },
    job: (ctx: RunJobContext) => Promise<unknown>
  ): RuntimeRunSnapshot {
    const now = runtimeTimestamp();
    const runId = input.runId ?? randomUUID();
    const bus = new EventBus();
    const controller = new AbortController();
    const run: ManagedRun = {
      id: runId,
      idea: input.idea,
      output_root: input.outputRoot,
      status: "queued",
      created_at: now,
      updated_at: now,
      event_count: 0,
      events: [],
      bus,
      controller,
      finalEventSeen: false,
      promise: Promise.resolve()
    };
    bus.subscribe((event) => this.recordEvent(run, event));
    void writeRunState(input.outputRoot, createRunState({ runId, idea: input.idea, outputRoot: input.outputRoot, now })).catch(() => undefined);
    run.promise = Promise.resolve()
      .then(async () => {
        const result = await job({ runId, events: bus, signal: controller.signal });
        run.result = result;
        this.persistRunState(run);
        if (!run.finalEventSeen) {
          await run.bus.emit({ type: "run.completed", run_id: runId, timestamp: runtimeTimestamp() });
        }
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        run.error = message;
        this.persistRunState(run);
        if (!run.finalEventSeen) {
          const event: Idea2RepoEvent = controller.signal.aborted
            ? { type: "run.cancelled", run_id: runId, reason: controller.signal.reason ? String(controller.signal.reason) : message, timestamp: runtimeTimestamp() }
            : { type: "run.failed", run_id: runId, error: message, timestamp: runtimeTimestamp() };
          await run.bus.emit(event);
        }
      });
    this.runs.set(runId, run);
    return this.snapshot(run);
  }

  get(runId: string): RuntimeRunRecord | undefined {
    const run = this.runs.get(runId);
    return run ? { ...this.snapshot(run), events: [...run.events] } : undefined;
  }

  list(): RuntimeRunSnapshot[] {
    return [...this.runs.values()].map((run) => this.snapshot(run));
  }

  subscribe(runId: string, listener: EventListener): (() => void) | null {
    return this.runs.get(runId)?.bus.subscribe(listener) ?? null;
  }

  eventSink(runId: string): EventSink | null {
    const run = this.runs.get(runId);
    return run ? { emit: (event) => run.bus.emit(event) } : null;
  }

  async cancel(runId: string, reason = "cancel requested"): Promise<RuntimeRunSnapshot | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (isFinalStatus(run.status)) return this.snapshot(run);
    run.controller.abort(reason);
    return this.snapshot(run);
  }

  private recordEvent(run: ManagedRun, event: Idea2RepoEvent): void {
    run.events.push(event);
    run.event_count = run.events.length;
    run.updated_at = event.timestamp;
    if (event.type === "run.started") run.status = "running";
    if (event.type === "stage.started" && run.status === "blocked") run.status = "running";
    if (event.type === "stage.blocked") run.status = "blocked";
    if (event.type === "run.completed") {
      run.status = "completed";
      run.finalEventSeen = true;
    }
    if (event.type === "run.failed") {
      run.status = "failed";
      run.error = event.error;
      run.finalEventSeen = true;
    }
    if (event.type === "run.cancelled") {
      run.status = "cancelled";
      run.finalEventSeen = true;
    }
    this.persistRunState(run, event.type);
  }

  private persistRunState(run: ManagedRun, lastEventType = run.events.at(-1)?.type): void {
    void writeRunState(run.output_root, {
      version: 1,
      id: run.id,
      idea: run.idea,
      output_root: run.output_root,
      status: run.status,
      created_at: run.created_at,
      updated_at: run.updated_at,
      event_count: run.event_count,
      ...(lastEventType ? { last_event_type: lastEventType } : {}),
      ...(run.result ? { result: run.result } : {}),
      ...(run.error ? { error: run.error } : {})
    }).catch(() => undefined);
  }

  private snapshot(run: ManagedRun): RuntimeRunSnapshot {
    return {
      id: run.id,
      idea: run.idea,
      output_root: run.output_root,
      status: run.status,
      created_at: run.created_at,
      updated_at: run.updated_at,
      event_count: run.event_count,
      ...(run.result ? { result: run.result } : {}),
      ...(run.error ? { error: run.error } : {})
    };
  }
}

export function isFinalStatus(status: RuntimeRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export type StageControlResult = {
  root: string;
  run_id: string;
  stage_id: ResearchStageId;
  action: "retry" | "skip";
  executed?: boolean;
  snapshots: ArtifactSnapshotRecord[];
};

export type RuntimeStateRestoreResult = {
  root: string;
  run_id: string;
  plan: PlanState;
  pipeline_state: ResearchPipelineState;
  trace_rebuilt: boolean;
  blocked_stages: Array<{ stage_id: ResearchStageId; artifacts: string[] }>;
  missing_artifacts: string[];
  modified_artifacts: string[];
  approvals: number;
};

export async function restoreRuntimeState(
  root: string,
  options: { runId?: string; events?: EventSink } = {}
): Promise<RuntimeStateRestoreResult> {
  const resolvedRoot = resolve(root);
  const manifest = await readManifest(resolvedRoot);
  const current = await projectStatus(resolvedRoot);
  const runId = options.runId ?? (await currentPlanRunId(resolvedRoot)) ?? (await latestTraceRunId(resolvedRoot)) ?? randomUUID();
  const existingState = await readResearchPipelineState(resolvedRoot);
  const repaired = repairPipelineStateForArtifacts(
    existingState ?? inferPipelineStateFromManifest(manifest.request.idea, resolvedRoot, manifest.artifacts.map((artifact) => artifact.path), current),
    current
  );
  await writeResearchPipelineState(resolvedRoot, repaired.state);
  const plan = planFromPipelineState(runId, repaired.state);
  await writePlanState(resolvedRoot, plan);
  await ensureRuntimeLogFile(resolvedRoot, APPROVALS_PATH);
  const traceRebuilt = await rebuildTraceIfMissing(resolvedRoot, runId, manifest.request.idea, repaired.state, plan, options.events);
  if (!traceRebuilt) await options.events?.emit({ type: "plan.updated", run_id: runId, plan: plan.items, timestamp: plan.updated_at });
  return {
    root: resolvedRoot,
    run_id: runId,
    plan,
    pipeline_state: repaired.state,
    trace_rebuilt: traceRebuilt,
    blocked_stages: repaired.blockedStages,
    missing_artifacts: current.missing_artifacts,
    modified_artifacts: current.modified_artifacts,
    approvals: (await readApprovalRecords(resolvedRoot)).length
  };
}

export async function skipRuntimeStage(
  root: string,
  stageId: ResearchStageId,
  reason: string,
  options: { runId?: string; events?: EventSink } = {}
): Promise<StageControlResult> {
  if (!reason.trim()) throw new Error("skip reason is required");
  const resolvedRoot = resolve(root);
  const stage = stageDefinition(stageId);
  const runId = options.runId ?? (await currentPlanRunId(resolvedRoot)) ?? randomUUID();
  const events = options.events ?? new JsonlEventSink(join(resolvedRoot, ".idea2repo", "trace.jsonl"));
  const state = await readOrCreatePipelineState(resolvedRoot);
  const nextState = markStage(state, stage.id, "skipped", { error: reason, artifacts: stage.artifactPaths });
  await writeResearchPipelineState(resolvedRoot, nextState);
  const event = { type: "stage.skipped" as const, run_id: runId, stage_id: stage.id, reason, timestamp: runtimeTimestamp() };
  await events.emit(event);
  await persistPlanState(resolvedRoot, runId, planFromPipelineState(runId, nextState), events);
  const decision = await new DecisionRecorder(resolvedRoot, runId, events).record({
    stage_id: stage.id,
    title: `Skipped ${stage.label}`,
    rationale_summary: reason,
    inputs_considered: [stage.id, reason],
    evidence_refs: stage.artifactPaths.map((artifact) => ({ artifact })),
    alternatives: [{ option: "Retry the stage", why_not: "The operator explicitly chose to skip it." }],
    confidence: "medium"
  });
  const decisionState = updateStageRefs(nextState, stage.id, { decision_ids: [decision.id], next_actions: ["Retry the stage"] });
  await writeResearchPipelineState(resolvedRoot, decisionState);
  await persistPlanState(resolvedRoot, runId, planFromPipelineState(runId, decisionState), events);
  return { root: resolvedRoot, run_id: runId, stage_id: stage.id, action: "skip", snapshots: [] };
}

export async function retryRuntimeStage(
  root: string,
  stageId: ResearchStageId,
  options: { runId?: string; reason?: string; events?: EventSink; execute?: boolean; allowNetwork?: boolean; downloadPdfs?: boolean; maxPapers?: number } = {}
): Promise<StageControlResult> {
  const resolvedRoot = resolve(root);
  const stage = stageDefinition(stageId);
  const runId = options.runId ?? (await currentPlanRunId(resolvedRoot)) ?? randomUUID();
  const events = options.events ?? new JsonlEventSink(join(resolvedRoot, ".idea2repo", "trace.jsonl"));
  const affectedStages = researchStages.filter((candidate) => candidate.index >= stage.index);
  const snapshots: ArtifactSnapshotRecord[] = [];
  for (const artifact of new Set(affectedStages.flatMap((candidate) => candidate.artifactPaths))) {
    const snapshot = await snapshotArtifact(resolvedRoot, artifact, { runId, events });
    if (snapshot) snapshots.push(snapshot);
  }
  const state = await readOrCreatePipelineState(resolvedRoot);
  const resetState = resetPipelineStateFrom(state, stage.id);
  await writeResearchPipelineState(resolvedRoot, resetState);
  await persistPlanState(resolvedRoot, runId, planFromPipelineState(runId, resetState), events);
  const decision = await new DecisionRecorder(resolvedRoot, runId, events).record({
    stage_id: stage.id,
    title: `Retry requested for ${stage.label}`,
    rationale_summary: options.reason?.trim() || `Reset ${stage.id} and downstream stages to pending for a controlled retry.`,
    inputs_considered: [stage.id, ...affectedStages.map((candidate) => candidate.id)],
    evidence_refs: snapshots.map((snapshot) => ({ artifact: snapshot.path })),
    alternatives: [{ option: "Resume without retry", why_not: "The operator requested a fresh stage attempt." }],
    confidence: "medium"
  });
  const decisionState = updateStageRefs(resetState, stage.id, { decision_ids: [decision.id], next_actions: [options.execute ? "Execute retry" : "Retry when ready"] });
  await writeResearchPipelineState(resolvedRoot, decisionState);
  await persistPlanState(resolvedRoot, runId, planFromPipelineState(runId, decisionState), events);
  if (options.execute) {
    await executeRetry(resolvedRoot, runId, events, { ...options, stageId: stage.id });
  }
  return { root: resolvedRoot, run_id: runId, stage_id: stage.id, action: "retry", executed: Boolean(options.execute), snapshots };
}

async function executeRetry(
  root: string,
  runId: string,
  events: EventSink,
  options: { stageId: ResearchStageId; allowNetwork?: boolean; downloadPdfs?: boolean; maxPapers?: number }
): Promise<void> {
  const state = await readOrCreatePipelineState(root);
  const manifest = await readManifest(root);
  const context = await readRuntimeRunContext(root);
  const approvalPolicy = approvalPolicyFromPermissions(
    {
      allowWrite: context?.approval_policy.allow_write ?? true,
      allowOverwrite: context?.approval_policy.allow_overwrite ?? true,
      allowNetwork: context?.approval_policy.allow_network ?? false,
      allowPublish: context?.approval_policy.allow_publish ?? false,
      allowShell: context?.approval_policy.allow_shell ?? false
    },
    "generate"
  );
  const pipelineEvents = new SuppressRunCompletedSink(events);
  const result = await runResearchPipeline(state.idea || manifest.request.idea, {
    outputRoot: root,
    provider: context?.provider ?? "offline",
    model: context?.model,
    reasoningEffort: context?.reasoning_effort,
    sources: context?.sources,
    venue: context?.venue ?? undefined,
    allowNetwork: options.allowNetwork ?? context?.allow_network ?? false,
    downloadPdfs: options.downloadPdfs ?? context?.download_pdfs ?? false,
    maxPapers: options.maxPapers ?? context?.max_papers ?? 20,
    requestedDomains: manifest.request.requested_domains,
    timelineWeeks: manifest.request.timeline_weeks,
    resources: manifest.request.resources,
    stack: manifest.request.stack,
    runId,
    events: pipelineEvents,
    approvalPolicy,
    approvalMode: "block",
    stageOverrides: { retryFromStage: options.stageId }
  });
  const written: string[] = [];
  for (const [relativePath, content] of Object.entries(result.artifacts)) {
    await writeRetriedArtifact(root, runId, events, relativePath, content);
    written.push(relativePath);
  }
  await refreshManifestArtifactHashes(root, written);
  await persistPlanState(root, runId, planFromPipelineState(runId, result.state), events);
  await events.emit({ type: "run.completed", run_id: runId, timestamp: runtimeTimestamp() });
}

async function writeRetriedArtifact(root: string, runId: string, events: EventSink, relativePath: string, content: string): Promise<void> {
  const path = ensureChild(root, relativePath);
  await snapshotArtifact(root, relativePath, { runId, events });
  await mkdir(dirname(path), { recursive: true });
  const data = relativePath.endsWith(".zip") ? Buffer.from(content, "latin1") : Buffer.from(ensureTrailingNewline(content), "utf8");
  await writeFile(path, data);
  await events.emit({
    type: "artifact.written",
    run_id: runId,
    path: relativePath,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.byteLength,
    timestamp: runtimeTimestamp()
  });
}

async function readOrCreatePipelineState(root: string): Promise<ResearchPipelineState> {
  const existing = await readResearchPipelineState(root);
  if (existing) return existing;
  const manifest = await readManifest(root);
  return createResearchPipelineState(manifest.request.idea, root);
}

function repairPipelineStateForArtifacts(
  state: ResearchPipelineState,
  current: Awaited<ReturnType<typeof projectStatus>>
): { state: ResearchPipelineState; blockedStages: Array<{ stage_id: ResearchStageId; artifacts: string[] }> } {
  const missingOrModified = new Set([...current.missing_artifacts, ...current.modified_artifacts]);
  let next = state;
  const blockedStages: Array<{ stage_id: ResearchStageId; artifacts: string[] }> = [];
  for (const stage of researchStages) {
    const snapshot = next.stages.find((candidate) => candidate.id === stage.id);
    if (!snapshot) continue;
    const affected = (snapshot.artifacts.length ? snapshot.artifacts : stage.artifactPaths).filter((artifact) => missingOrModified.has(artifact));
    if (!affected.length) continue;
    blockedStages.push({ stage_id: stage.id, artifacts: affected });
    next = markStage(next, stage.id, "failed", {
      artifacts: snapshot.artifacts,
      error: `Artifact missing or modified: ${affected.join(", ")}`
    });
  }
  return { state: next, blockedStages };
}

function inferPipelineStateFromManifest(
  idea: string,
  root: string,
  manifestArtifacts: string[],
  current: Awaited<ReturnType<typeof projectStatus>>
): ResearchPipelineState {
  let state = createResearchPipelineState(idea, root);
  const missingOrModified = new Set([...current.missing_artifacts, ...current.modified_artifacts]);
  const manifestArtifactSet = new Set(manifestArtifacts);
  for (const stage of researchStages) {
    const declared = stage.artifactPaths.filter((artifact) => manifestArtifactSet.has(artifact));
    if (!declared.length) continue;
    const affected = declared.filter((artifact) => missingOrModified.has(artifact));
    if (affected.length) {
      state = markStage(state, stage.id, "failed", {
        artifacts: stage.artifactPaths,
        error: `Artifact missing or modified: ${affected.join(", ")}`
      });
    } else {
      state = markStage(state, stage.id, "completed", { artifacts: stage.artifactPaths });
    }
  }
  return state;
}

function resetPipelineStateFrom(state: ResearchPipelineState, stageId: ResearchStageId): ResearchPipelineState {
  const target = stageDefinition(stageId);
  const affected = new Set(researchStages.filter((stage) => stage.index >= target.index).map((stage) => stage.id));
  const updatedAt = runtimeTimestamp();
  return {
    ...state,
    updated_at: updatedAt,
    stages: state.stages.map((stage) =>
      affected.has(stage.id)
        ? (() => {
            const definition = stageDefinition(stage.id);
            return {
            ...stage,
            status: "pending" as const,
            error: undefined,
            blocker: undefined,
            evidence_refs: [],
            decision_ids: [],
            next_actions: [`Run ${definition.label}`]
          };
        })()
        : stage
    )
  };
}

function planFromPipelineState(runId: string, state: ResearchPipelineState): PlanState {
  const now = runtimeTimestamp();
  return {
    version: 1,
    run_id: runId,
    updated_at: now,
    items: researchStages.map((stage) => {
      const snapshot = state.stages.find((candidate) => candidate.id === stage.id);
      return {
        id: stage.id,
        stage_id: stage.id,
        step: stage.label,
        status: snapshot?.status === "completed" ? "completed" : snapshot?.status === "running" ? "in_progress" : snapshot?.status === "skipped" ? "skipped" : snapshot?.status === "failed" || snapshot?.status === "blocked" ? "blocked" : "pending",
        ...(snapshot?.blocker ?? snapshot?.error ? { blocker: snapshot.blocker ?? snapshot.error } : {}),
        artifacts: snapshot?.artifacts ?? stage.artifactPaths,
        input_refs: snapshot?.input_refs ?? [],
        output_refs: snapshot?.output_refs ?? snapshot?.artifacts ?? stage.artifactPaths,
        evidence_refs: snapshot?.evidence_refs ?? [],
        decision_ids: snapshot?.decision_ids ?? [],
        next_actions: snapshot?.next_actions ?? [`Run ${stage.label}`],
        updated_at: state.updated_at || now
      };
    })
  };
}

async function persistPlanState(root: string, runId: string, state: PlanState, events: EventSink): Promise<void> {
  await writePlanState(root, state);
  await events.emit({ type: "plan.updated", run_id: runId, plan: state.items, timestamp: state.updated_at });
}

async function currentPlanRunId(root: string): Promise<string | null> {
  try {
    return (await readPlanState(root)).run_id;
  } catch {
    return null;
  }
}

async function latestTraceRunId(root: string): Promise<string | null> {
  try {
    const events = await readJsonlEvents(join(root, ".idea2repo", "trace.jsonl"));
    return [...events].reverse().find((event) => event.run_id)?.run_id ?? null;
  } catch {
    return null;
  }
}

async function rebuildTraceIfMissing(
  root: string,
  runId: string,
  idea: string,
  state: ResearchPipelineState,
  plan: PlanState,
  downstream?: EventSink
): Promise<boolean> {
  const tracePath = join(root, ".idea2repo", "trace.jsonl");
  const shouldRebuild = !(await exists(tracePath)) || !(await readFile(tracePath, "utf8").catch(() => "")).trim();
  if (!shouldRebuild) return false;
  const trace = new JsonlEventSink(tracePath);
  const emit = async (event: Idea2RepoEvent): Promise<void> => {
    await trace.emit(event);
    await downstream?.emit(event);
  };
  await emit({ type: "run.started", run_id: runId, idea, output_root: root, timestamp: state.created_at || runtimeTimestamp() });
  for (const snapshot of state.stages) {
    const stage = researchStages.find((candidate) => candidate.id === snapshot.id);
    const label = stage?.label ?? snapshot.id;
    const startedAt = snapshot.started_at ?? snapshot.completed_at ?? state.updated_at;
    if (snapshot.status === "running") {
      await emit({ type: "stage.started", run_id: runId, stage_id: snapshot.id, label, timestamp: startedAt });
    } else if (snapshot.status === "completed") {
      await emit({ type: "stage.completed", run_id: runId, stage_id: snapshot.id, artifacts: snapshot.artifacts, timestamp: snapshot.completed_at ?? state.updated_at });
    } else if (snapshot.status === "skipped") {
      await emit({ type: "stage.skipped", run_id: runId, stage_id: snapshot.id, reason: snapshot.error ?? "stage skipped", timestamp: snapshot.completed_at ?? state.updated_at });
    } else if (snapshot.status === "failed") {
      await emit({ type: "stage.failed", run_id: runId, stage_id: snapshot.id, error: snapshot.error ?? "stage failed", timestamp: snapshot.completed_at ?? state.updated_at });
    } else if (snapshot.status === "blocked") {
      await emit({ type: "stage.blocked", run_id: runId, stage_id: snapshot.id, reason: snapshot.error ?? "stage blocked", timestamp: snapshot.completed_at ?? state.updated_at });
    }
  }
  await emit({ type: "plan.updated", run_id: runId, plan: plan.items, timestamp: plan.updated_at });
  if (state.stages.every((stage) => stage.status === "completed" || stage.status === "skipped")) await emit({ type: "run.completed", run_id: runId, timestamp: plan.updated_at });
  return true;
}

async function ensureRuntimeLogFile(root: string, relativePath: string): Promise<void> {
  const path = ensureChild(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", { encoding: "utf8", flag: "a" });
}

class SuppressRunCompletedSink implements EventSink {
  constructor(private readonly downstream: EventSink) {}

  async emit(event: Idea2RepoEvent): Promise<void> {
    if (event.type === "run.completed") return;
    await this.downstream.emit(event);
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
