import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runResearchPipeline } from "../src/pipeline/research-pipeline.js";
import { createResearchPipelineState, readResearchPipelineState, writeResearchPipelineState } from "../src/pipeline/stage-state.js";
import { researchStages, stageDefinition } from "../src/pipeline/stages.js";
import { ResearchPipelineResultSchema, validateWithSchema, type ResearchPipelineSchemaResult } from "../src/agents/schemas.js";

test("offline research pipeline returns resumable stage state and core artifacts", async () => {
  const result = await runResearchPipeline("Build an LLM agent benchmark with baselines, datasets, metrics, and ablations.", {
    requestedDomains: ["AI/LLM Agent"],
    timelineWeeks: 12,
    resources: ["single researcher"],
    provider: "offline",
    strictCcfA: true
  });
  assert.equal(result.state.stages.length, 13);
  assert.equal(result.state.stages.every((stage) => stage.status === "completed"), true);
  assert.equal(result.searchPlan.precision_queries.length >= 5, true);
  assert.equal(result.searchPlan.recall_queries.length >= 5, true);
  assert.equal(validateWithSchema<ResearchPipelineSchemaResult>(ResearchPipelineResultSchema, result, "ResearchPipelineResult"), result);
  assert.ok(result.artifacts["docs/relative_work/search_plan.json"]);
  assert.ok(result.artifacts["docs/diagnosis/ccf_a_strict_scorecard.md"]?.includes("Strict mode: enabled"));
  assert.ok(result.artifacts["docs/diagnosis/feasibility_report.md"]);
  assert.ok(result.artifacts["docs/proposal/revised_idea.md"]);
  assert.ok(result.artifacts["docs/submission/template_compliance_report.md"]);
  assert.ok(result.artifacts["paper/main.tex"]);
  for (const stage of result.state.stages) {
    for (const artifact of stage.artifacts) assert.ok(Object.hasOwn(result.artifacts, artifact), `missing declared artifact ${stage.id}:${artifact}`);
  }
  assert.deepEqual(stageDefinition("venue_template_packaging").prompts, [
    "10_venue_template_selector.md",
    "11_latex_template_packager.md",
    "12_template_compliance_reviewer.md"
  ]);
});

test("research pipeline state can be written and read", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-state-"));
  try {
    const state = createResearchPipelineState("test idea", root);
    await writeResearchPipelineState(root, state);
    const raw = await readFile(join(root, ".idea2repo", "research_pipeline_state.json"), "utf8");
    assert.ok(raw.includes("idea_intake"));
    const restored = await readResearchPipelineState(root);
    assert.equal(restored?.stages.length, researchStages.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
