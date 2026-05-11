import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateResearchRepo } from "../src/generator.js";
import { OFFLINE_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../src/providers.js";
import { CodexCliAdapter, OpenAICodexOAuthAdapter, OfflineAdapter, createProviderAdapter } from "../src/providers/index.js";
import { validateResearchAnalysis, type ResearchAnalysis } from "../src/types.js";

test("offline provider adapter returns schema-valid deterministic research analysis", async () => {
  const adapter = new OfflineAdapter();
  const status = await adapter.status();
  const analysis = await adapter.structured({
    task: "analyze",
    schemaName: "ResearchAnalysis",
    context: {
      idea: "A local-first research agent benchmark with baselines datasets and metrics.",
      requestedDomains: ["ai"],
      timelineWeeks: 12,
      resources: ["single researcher"],
      stack: "ts"
    },
    validate: validateResearchAnalysis
  });

  assert.equal(await adapter.available(), true);
  assert.equal(status.id, OFFLINE_PROVIDER_ID);
  assert.equal(analysis.domain_route.key, "ai_llm_agent");
  assert.ok(analysis.related_work_queries?.length);
});

test("provider adapter factory wraps offline and Codex OAuth providers", async () => {
  assert.ok(createProviderAdapter(OFFLINE_PROVIDER_ID) instanceof OfflineAdapter);
  assert.ok(createProviderAdapter(OPENAI_CODEX_PROVIDER_ID) instanceof OpenAICodexOAuthAdapter);
  assert.ok(createProviderAdapter("openai-codex-cli") instanceof CodexCliAdapter);
  assert.throws(() => createProviderAdapter("missing"), /unsupported provider adapter/);
});

test("Codex OAuth adapter delegates structured ResearchAnalysis requests to the client", async () => {
  const expected = validateResearchAnalysis({
    schema_version: 1,
    idea_summary: "Adapter test",
    problem_statement: "Need a typed adapter.",
    domain_route: { key: "ai_agent", label: "AI / LLM Agent", rationale: "Agent runtime work." },
    raw_score: { total: 40, rationale: "early" },
    revised_score: { total: 55, rationale: "clearer" },
    feasibility: "feasible",
    revised_plan: { summary: "typed adapter", feasibility: "feasible" },
    experiment_plan: {},
    reviewer_simulation: "Reviewer asks for tests."
  });
  const adapter = new OpenAICodexOAuthAdapter(() => ({
    analyzeIdea: async () => ({ analysis: expected, provider_id: OPENAI_CODEX_PROVIDER_ID, api_shape: "openai-codex-responses", codex_model: "test", events: [] })
  } as any));

  const analysis = await adapter.structured<ResearchAnalysis>({
    task: "analyze",
    schemaName: "ResearchAnalysis",
    context: { idea: "Adapter test" },
    validate: validateResearchAnalysis,
    model: "gpt-test",
    reasoningEffort: "low"
  });
  assert.equal(analysis.idea_summary, "Adapter test");
});

test("generation uses the offline provider adapter while preserving offline fallback metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-provider-adapter-"));
  try {
    const result = await generateResearchRepo("A research agent benchmark with baseline dataset and metric.", join(root, "project"), {
      offline: true,
      provider: OFFLINE_PROVIDER_ID
    });
    assert.equal(result.provider_id, OFFLINE_PROVIDER_ID);
    assert.equal(result.analysis_source, "offline_fallback");
    assert.equal(result.fallback_reason, "offline mode requested");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
