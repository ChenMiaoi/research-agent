import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists } from "../state.js";
import { researchStages, type ResearchStageId, type ResearchStageStatus } from "./stages.js";

export const RESEARCH_PIPELINE_STATE_PATH = join(".idea2repo", "research_pipeline_state.json");

export type ResearchStageSnapshot = {
  id: ResearchStageId;
  status: ResearchStageStatus;
  started_at?: string;
  completed_at?: string;
  error?: string;
  blocker?: string;
  artifacts: string[];
  input_refs: string[];
  output_refs: string[];
  evidence_refs: string[];
  decision_ids: string[];
  next_actions: string[];
};

export type ResearchPipelineState = {
  version: 1;
  idea: string;
  output_root?: string;
  created_at: string;
  updated_at: string;
  stages: ResearchStageSnapshot[];
};

export function createResearchPipelineState(idea: string, outputRoot?: string, now = timestamp()): ResearchPipelineState {
  return {
    version: 1,
    idea,
    output_root: outputRoot,
    created_at: now,
    updated_at: now,
    stages: researchStages.map((stage) => ({
      id: stage.id,
      status: "pending",
      artifacts: [...stage.artifactPaths],
      input_refs: defaultInputRefs(stage.id),
      output_refs: [...stage.artifactPaths],
      evidence_refs: [],
      decision_ids: [],
      next_actions: defaultNextActions(stage.id)
    }))
  };
}

export function markStage(
  state: ResearchPipelineState,
  id: ResearchStageId,
  status: ResearchStageStatus,
  options: {
    error?: string;
    blocker?: string;
    artifacts?: string[];
    input_refs?: string[];
    output_refs?: string[];
    evidence_refs?: string[];
    decision_ids?: string[];
    next_actions?: string[];
    now?: string;
  } = {}
): ResearchPipelineState {
  const now = options.now ?? timestamp();
  const stages = state.stages.map((stage) => {
    if (stage.id !== id) return stage;
    const outputRefs = options.output_refs ?? options.artifacts ?? stage.output_refs ?? stage.artifacts;
    const error = status === "running" ? undefined : options.error;
    const blocker = status === "running" ? undefined : options.blocker ?? options.error ?? stage.blocker;
    return {
      ...stage,
      status,
      started_at: status === "running" ? now : stage.started_at,
      completed_at: status === "completed" || status === "failed" || status === "skipped" ? now : status === "running" ? undefined : stage.completed_at,
      error,
      blocker,
      artifacts: options.artifacts ?? outputRefs,
      input_refs: options.input_refs ?? stage.input_refs ?? defaultInputRefs(id),
      output_refs: outputRefs,
      evidence_refs: mergeRefs(stage.evidence_refs, options.evidence_refs),
      decision_ids: mergeRefs(stage.decision_ids, options.decision_ids),
      next_actions: options.next_actions ?? stage.next_actions ?? defaultNextActions(id)
    };
  });
  return { ...state, updated_at: now, stages };
}

export function updateStageRefs(
  state: ResearchPipelineState,
  id: ResearchStageId,
  updates: {
    input_refs?: string[];
    output_refs?: string[];
    evidence_refs?: string[];
    decision_ids?: string[];
    next_actions?: string[];
    blocker?: string;
    now?: string;
  }
): ResearchPipelineState {
  const now = updates.now ?? timestamp();
  return {
    ...state,
    updated_at: now,
    stages: state.stages.map((stage) =>
      stage.id === id
        ? {
            ...stage,
            input_refs: mergeRefs(stage.input_refs, updates.input_refs),
            output_refs: mergeRefs(stage.output_refs, updates.output_refs),
            artifacts: mergeRefs(stage.artifacts, updates.output_refs),
            evidence_refs: mergeRefs(stage.evidence_refs, updates.evidence_refs),
            decision_ids: mergeRefs(stage.decision_ids, updates.decision_ids),
            next_actions: updates.next_actions ?? stage.next_actions,
            blocker: updates.blocker ?? stage.blocker
          }
        : stage
    )
  };
}

export async function readResearchPipelineState(root: string): Promise<ResearchPipelineState | null> {
  const path = join(root, RESEARCH_PIPELINE_STATE_PATH);
  if (!(await exists(path))) return null;
  return normalizeResearchPipelineState(JSON.parse(await readFile(path, "utf8")) as ResearchPipelineState);
}

export async function writeResearchPipelineState(root: string, state: ResearchPipelineState): Promise<string> {
  const path = join(root, RESEARCH_PIPELINE_STATE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  return path;
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeResearchPipelineState(state: ResearchPipelineState): ResearchPipelineState {
  return {
    ...state,
    stages: state.stages.map((stage) => ({
      ...stage,
      blocker: stage.blocker ?? stage.error,
      input_refs: stage.input_refs ?? defaultInputRefs(stage.id),
      output_refs: stage.output_refs ?? stage.artifacts ?? [],
      artifacts: stage.artifacts ?? stage.output_refs ?? [],
      evidence_refs: stage.evidence_refs ?? [],
      decision_ids: stage.decision_ids ?? [],
      next_actions: stage.next_actions ?? defaultNextActions(stage.id)
    }))
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

function defaultNextActions(id: ResearchStageId): string[] {
  const stage = researchStages.find((candidate) => candidate.id === id);
  return stage ? [`Run ${stage.label}`] : [];
}

function mergeRefs(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  return [...new Set([...(existing ?? []), ...(incoming ?? [])].filter(Boolean))];
}
