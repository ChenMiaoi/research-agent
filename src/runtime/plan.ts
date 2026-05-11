import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { researchStages, type ResearchStageId } from "../pipeline/stages.js";
import { runtimeTimestamp, type EventSink, type Idea2RepoEvent, type RuntimePlanItem } from "./events.js";

export const PLAN_STATE_PATH = join(".idea2repo", "plan.json");

export type PlanItemStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";

export type PlanItem = RuntimePlanItem & {
  status: PlanItemStatus;
};

export type PlanState = {
  version: 1;
  run_id: string;
  items: PlanItem[];
  updated_at: string;
};

export function createPlanState(runId: string, now = runtimeTimestamp()): PlanState {
  return {
    version: 1,
    run_id: runId,
    updated_at: now,
    items: researchStages.map((stage) => ({
      id: stage.id,
      stage_id: stage.id,
      step: stage.label,
      status: "pending",
      artifacts: [...stage.artifactPaths],
      input_refs: defaultInputRefs(stage.id),
      output_refs: [...stage.artifactPaths],
      evidence_refs: [],
      decision_ids: [],
      next_actions: [`Run ${stage.label}`],
      updated_at: now
    }))
  };
}

export function updatePlanForStageEvent(state: PlanState, event: Idea2RepoEvent, now = event.timestamp): PlanState {
  if (isDecisionEvent(event)) return updatePlanForDecision(state, event, now);
  if (isEvidenceEvent(event)) return updatePlanRefs(state, "pdf_reading", { evidence_refs: [event.evidence_id] }, now);
  if (isArtifactEvent(event)) {
    const stageId = stageForArtifact(event.path);
    return stageId ? updatePlanRefs(state, stageId, { output_refs: [event.path], artifacts: [event.path] }, now) : state;
  }
  if (!isStageEvent(event)) return state;
  const status = planStatusForStageEvent(event);
  const items = state.items.map((item) => {
    if (item.stage_id !== event.stage_id) {
      if (status === "in_progress" && item.status === "in_progress") return { ...item, status: "pending" as const, updated_at: now };
      return item;
    }
    return {
      ...item,
      status,
      blocker: blockerForEvent(event),
      artifacts: event.type === "stage.completed" ? event.artifacts : item.artifacts,
      output_refs: event.type === "stage.completed" ? mergeRefs(item.output_refs, event.artifacts) : item.output_refs,
      next_actions: nextActionsForStageEvent(event),
      updated_at: now
    };
  });
  return { ...state, items, updated_at: now };
}

export async function writePlanState(root: string, state: PlanState): Promise<string> {
  const path = join(root, PLAN_STATE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  return path;
}

export async function readPlanState(root: string): Promise<PlanState> {
  return normalizePlanState(JSON.parse(await readFile(join(root, PLAN_STATE_PATH), "utf8")) as PlanState);
}

export function formatPlan(state: PlanState): string {
  return state.items.map((item) => `${mark(item.status)} ${item.step}${item.blocker ? ` - ${item.blocker}` : ""}`).join("\n");
}

export function stageIdFromPlanItem(item: PlanItem): ResearchStageId | undefined {
  return researchStages.find((stage) => stage.id === item.stage_id)?.id;
}

function isPlanEvent(event: Idea2RepoEvent): boolean {
  return isStageEvent(event) || isDecisionEvent(event) || isEvidenceEvent(event) || isArtifactEvent(event);
}

function isStageEvent(event: Idea2RepoEvent): event is Extract<Idea2RepoEvent, { stage_id: string }> {
  return event.type === "stage.started" || event.type === "stage.completed" || event.type === "stage.skipped" || event.type === "stage.failed" || event.type === "stage.blocked";
}

function isDecisionEvent(event: Idea2RepoEvent): event is Extract<Idea2RepoEvent, { type: "decision.recorded" }> {
  return event.type === "decision.recorded" && Boolean(event.stage_id);
}

function isEvidenceEvent(event: Idea2RepoEvent): event is Extract<Idea2RepoEvent, { type: "evidence.extracted" }> {
  return event.type === "evidence.extracted";
}

function isArtifactEvent(event: Idea2RepoEvent): event is Extract<Idea2RepoEvent, { type: "artifact.written" }> {
  return event.type === "artifact.written";
}

function planStatusForStageEvent(event: Extract<Idea2RepoEvent, { stage_id: string }>): PlanItemStatus {
  if (event.type === "stage.started") return "in_progress";
  if (event.type === "stage.completed") return "completed";
  if (event.type === "stage.skipped") return "skipped";
  return "blocked";
}

function blockerForEvent(event: Extract<Idea2RepoEvent, { stage_id: string }>): string | undefined {
  if (event.type === "stage.skipped") return event.reason;
  if (event.type === "stage.failed") return event.error;
  if (event.type === "stage.blocked") return event.reason;
  return undefined;
}

function mark(status: PlanItemStatus): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[>]";
  if (status === "blocked") return "[!]";
  if (status === "skipped") return "[-]";
  return "[ ]";
}

function updatePlanForDecision(state: PlanState, event: Extract<Idea2RepoEvent, { type: "decision.recorded" }>, now: string): PlanState {
  if (!event.stage_id) return state;
  return updatePlanRefs(state, event.stage_id, { decision_ids: [event.decision_id], next_actions: [`Review decision: ${event.title}`] }, now);
}

function updatePlanRefs(
  state: PlanState,
  stageId: string,
  refs: Partial<Pick<PlanItem, "artifacts" | "input_refs" | "output_refs" | "evidence_refs" | "decision_ids" | "next_actions">>,
  now: string
): PlanState {
  const items = state.items.map((item) =>
    item.stage_id === stageId
      ? {
          ...item,
          artifacts: mergeRefs(item.artifacts, refs.artifacts),
          input_refs: mergeRefs(item.input_refs, refs.input_refs),
          output_refs: mergeRefs(item.output_refs, refs.output_refs),
          evidence_refs: mergeRefs(item.evidence_refs, refs.evidence_refs),
          decision_ids: mergeRefs(item.decision_ids, refs.decision_ids),
          next_actions: refs.next_actions ?? item.next_actions,
          updated_at: now
        }
      : item
  );
  return { ...state, items, updated_at: now };
}

function nextActionsForStageEvent(event: Extract<Idea2RepoEvent, { stage_id: string }>): string[] {
  if (event.type === "stage.completed") return ["Inspect output refs and continue."];
  if (event.type === "stage.skipped") return [`Resolve skipped stage if needed: ${event.reason}`];
  if (event.type === "stage.failed") return [`Fix blocker: ${event.error}`];
  if (event.type === "stage.blocked") return [`Resolve blocker: ${event.reason}`];
  return [`Run ${event.stage_id}`];
}

function stageForArtifact(path: string): ResearchStageId | null {
  return researchStages.find((stage) => stage.artifactPaths.includes(path))?.id ?? null;
}

function normalizePlanState(state: PlanState): PlanState {
  return {
    ...state,
    items: state.items.map((item) => {
      const stage = researchStages.find((candidate) => candidate.id === item.stage_id);
      return {
        ...item,
        input_refs: item.input_refs ?? (stage ? defaultInputRefs(stage.id) : []),
        output_refs: item.output_refs ?? item.artifacts ?? [],
        artifacts: item.artifacts ?? item.output_refs ?? [],
        evidence_refs: item.evidence_refs ?? [],
        decision_ids: item.decision_ids ?? [],
        next_actions: item.next_actions ?? (stage ? [`Run ${stage.label}`] : [])
      };
    })
  };
}

function defaultInputRefs(id: ResearchStageId): string[] {
  const index = researchStages.find((stage) => stage.id === id)?.index ?? 0;
  if (index === 0) return ["idea"];
  return researchStages
    .filter((stage) => stage.index < index)
    .slice(-1)
    .flatMap((stage) => stage.artifactPaths);
}

function mergeRefs(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  return [...new Set([...(existing ?? []), ...(incoming ?? [])].filter(Boolean))];
}

export class PlanEventSink implements EventSink {
  private state: PlanState;

  constructor(
    private readonly root: string,
    runId: string,
    private readonly downstream?: EventSink,
    initialState?: PlanState
  ) {
    this.state = initialState ? normalizePlanState(initialState) : createPlanState(runId);
  }

  current(): PlanState {
    return this.state;
  }

  async emit(event: Idea2RepoEvent): Promise<void> {
    await this.downstream?.emit(event);
    if (!isPlanEvent(event)) return;
    this.state = updatePlanForStageEvent(this.state, event);
    await writePlanState(this.root, this.state);
    await this.downstream?.emit({ type: "plan.updated", run_id: this.state.run_id, plan: this.state.items, timestamp: this.state.updated_at });
  }
}
