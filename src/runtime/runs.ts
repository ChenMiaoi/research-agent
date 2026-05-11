import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runResearchPipeline } from "../pipeline/research-pipeline.js";
import { createResearchPipelineState, markStage, readResearchPipelineState, writeResearchPipelineState, type ResearchPipelineState } from "../pipeline/stage-state.js";
import { researchStages, stageDefinition, type ResearchStageId } from "../pipeline/stages.js";
import { ensureChild, readManifest } from "../state.js";
import { DecisionRecorder } from "./decisions.js";
import { readPlanState, writePlanState, type PlanState } from "./plan.js";
import { JsonlEventSink, EventBus, runtimeTimestamp, type EventSink, type EventListener, type Idea2RepoEvent } from "./events.js";
import { refreshManifestArtifactHashes, snapshotArtifact, type ArtifactSnapshotRecord } from "./artifacts.js";

export type RuntimeRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
    run.promise = Promise.resolve()
      .then(async () => {
        const result = await job({ runId, events: bus, signal: controller.signal });
        run.result = result;
        if (!run.finalEventSeen) {
          await run.bus.emit({ type: "run.completed", run_id: runId, timestamp: runtimeTimestamp() });
        }
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        run.error = message;
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
  await new DecisionRecorder(resolvedRoot, runId, events).record({
    stage_id: stage.id,
    title: `Skipped ${stage.label}`,
    rationale_summary: reason,
    inputs_considered: [stage.id, reason],
    evidence_refs: stage.artifactPaths.map((artifact) => ({ artifact })),
    alternatives: [{ option: "Retry the stage", why_not: "The operator explicitly chose to skip it." }],
    confidence: "medium"
  });
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
  await new DecisionRecorder(resolvedRoot, runId, events).record({
    stage_id: stage.id,
    title: `Retry requested for ${stage.label}`,
    rationale_summary: options.reason?.trim() || `Reset ${stage.id} and downstream stages to pending for a controlled retry.`,
    inputs_considered: [stage.id, ...affectedStages.map((candidate) => candidate.id)],
    evidence_refs: snapshots.map((snapshot) => ({ artifact: snapshot.path })),
    alternatives: [{ option: "Resume without retry", why_not: "The operator requested a fresh stage attempt." }],
    confidence: "medium"
  });
  if (options.execute) {
    await executeRetry(resolvedRoot, runId, events, options);
  }
  return { root: resolvedRoot, run_id: runId, stage_id: stage.id, action: "retry", executed: Boolean(options.execute), snapshots };
}

async function executeRetry(
  root: string,
  runId: string,
  events: EventSink,
  options: { allowNetwork?: boolean; downloadPdfs?: boolean; maxPapers?: number }
): Promise<void> {
  const state = await readOrCreatePipelineState(root);
  const manifest = await readManifest(root);
  const pipelineEvents = new SuppressRunCompletedSink(events);
  const result = await runResearchPipeline(state.idea || manifest.request.idea, {
    outputRoot: root,
    provider: "offline",
    allowNetwork: Boolean(options.allowNetwork),
    downloadPdfs: Boolean(options.downloadPdfs),
    maxPapers: options.maxPapers ?? 20,
    requestedDomains: manifest.request.requested_domains,
    timelineWeeks: manifest.request.timeline_weeks,
    resources: manifest.request.resources,
    stack: manifest.request.stack,
    runId,
    events: pipelineEvents
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

function resetPipelineStateFrom(state: ResearchPipelineState, stageId: ResearchStageId): ResearchPipelineState {
  const target = stageDefinition(stageId);
  const affected = new Set(researchStages.filter((stage) => stage.index >= target.index).map((stage) => stage.id));
  const updatedAt = runtimeTimestamp();
  return {
    ...state,
    updated_at: updatedAt,
    stages: state.stages.map((stage) =>
      affected.has(stage.id)
        ? { id: stage.id, status: "pending" as const, artifacts: stage.artifacts }
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
        status: snapshot?.status === "completed" ? "completed" : snapshot?.status === "running" ? "in_progress" : snapshot?.status === "failed" || snapshot?.status === "skipped" ? "blocked" : "pending",
        ...(snapshot?.error ? { blocker: snapshot.error } : {}),
        artifacts: snapshot?.artifacts ?? stage.artifactPaths,
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
