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
  artifacts: string[];
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
      artifacts: [...stage.artifactPaths]
    }))
  };
}

export function markStage(
  state: ResearchPipelineState,
  id: ResearchStageId,
  status: ResearchStageStatus,
  options: { error?: string; artifacts?: string[]; now?: string } = {}
): ResearchPipelineState {
  const now = options.now ?? timestamp();
  const stages = state.stages.map((stage) => {
    if (stage.id !== id) return stage;
    return {
      ...stage,
      status,
      started_at: status === "running" ? now : stage.started_at,
      completed_at: status === "completed" || status === "failed" || status === "skipped" ? now : stage.completed_at,
      error: options.error,
      artifacts: options.artifacts ?? stage.artifacts
    };
  });
  return { ...state, updated_at: now, stages };
}

export async function readResearchPipelineState(root: string): Promise<ResearchPipelineState | null> {
  const path = join(root, RESEARCH_PIPELINE_STATE_PATH);
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, "utf8")) as ResearchPipelineState;
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
