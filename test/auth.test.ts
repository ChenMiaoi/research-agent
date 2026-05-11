import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuthStorage, CodexOAuthClient, authPath, parseUsageSnapshot } from "../src/auth/codex-oauth.js";

test("AuthStorage stores Codex OAuth credentials outside generated repos with restricted permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "idea2repo-auth-"));
  const previous = process.env.IDEA2REPO_HOME;
  process.env.IDEA2REPO_HOME = home;
  try {
    const storage = new AuthStorage();
    await storage.set("openai-codex", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "account-id"
    });
    const credentials = await storage.get();
    assert.equal(credentials?.accountId, "account-id");
    assert.equal(credentials?.access, "access-token");
    const fileMode = (await stat(authPath())).mode & 0o777;
    if (platform() !== "win32") assert.equal(fileMode, 0o600);
    await storage.logout();
    assert.equal(await storage.get(), null);
  } finally {
    if (previous == null) delete process.env.IDEA2REPO_HOME;
    else process.env.IDEA2REPO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("CodexOAuthClient parses structured SSE responses", async () => {
  const home = await mkdtemp(join(tmpdir(), "idea2repo-sse-"));
  const previous = process.env.IDEA2REPO_HOME;
  process.env.IDEA2REPO_HOME = home;
  try {
    const storage = new AuthStorage();
    await storage.set("openai-codex", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "account-id"
    });
    const analysis = sampleAnalysis();
    const text = JSON.stringify(analysis);
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text.slice(0, 40) })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text.slice(40) })}`,
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n");
    const client = new CodexOAuthClient({
      storage,
      fetchImpl: async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }),
      maxRetries: 0
    });
    const result = await client.analyzeIdea("test idea");
    assert.equal(result.analysis.idea_summary, analysis.idea_summary);
    assert.equal(result.provider_id, "openai-codex");
  } finally {
    if (previous == null) delete process.env.IDEA2REPO_HOME;
    else process.env.IDEA2REPO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("CodexOAuthClient parses project-name suggestions", async () => {
  const home = await mkdtemp(join(tmpdir(), "idea2repo-name-"));
  const previous = process.env.IDEA2REPO_HOME;
  process.env.IDEA2REPO_HOME = home;
  try {
    const storage = new AuthStorage();
    await storage.set("openai-codex", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "account-id"
    });
    const client = new CodexOAuthClient({
      storage,
      fetchImpl: async () =>
        new Response(JSON.stringify({ project_name: "memory-agent-benchmark" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
      maxRetries: 0
    });
    const result = await client.suggestProjectName("LLM agents need long-term memory compression");
    assert.equal(result.project_name, "memory-agent-benchmark");
  } finally {
    if (previous == null) delete process.env.IDEA2REPO_HOME;
    else process.env.IDEA2REPO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("CodexOAuthClient runs split staged agent prompts", async () => {
  const home = await mkdtemp(join(tmpdir(), "idea2repo-staged-agent-"));
  const previous = process.env.IDEA2REPO_HOME;
  process.env.IDEA2REPO_HOME = home;
  try {
    const storage = new AuthStorage();
    await storage.set("openai-codex", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "account-id"
    });
    let requestBody = "";
    const client = new CodexOAuthClient({
      storage,
      fetchImpl: async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(JSON.stringify(sampleSearchPlan()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      },
      maxRetries: 0
    });
    const result = await client.planLiteratureSearch("agent benchmark", { targetVenues: ["NeurIPS"] });
    assert.equal(result.search_plan.precision_queries.length, 5);
    assert.equal(result.provider_id, "openai-codex");
    assert.match(requestBody, /01 Search Planner/);
    assert.match(requestBody, /SearchPlan/);
  } finally {
    if (previous == null) delete process.env.IDEA2REPO_HOME;
    else process.env.IDEA2REPO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex usage parser accepts primary and secondary rate-limit windows", () => {
  const parsed = parseUsageSnapshot(
    {
      data: {
        rate_limits: {
          limitName: "codex",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1_900_000_000_000 },
          credits: { has_credits: true, unlimited: false, balance: 123 },
          plan_type: "pro"
        }
      }
    },
    "test"
  );
  assert.equal(parsed.available, true);
  assert.equal(parsed.limitName, "codex");
  assert.equal(parsed.primary?.windowMinutes, 300);
  assert.equal(parsed.primary?.resetsAt, 1_800_000_000_000);
  assert.equal(parsed.secondary?.windowMinutes, 10080);
  assert.equal(parsed.secondary?.resetsAt, 1_900_000_000_000);
  assert.equal(parsed.credits?.balance, 123);
});

test("Codex usage parser accepts ChatGPT wham usage shape", () => {
  const parsed = parseUsageSnapshot({
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: "2026-05-10T12:00:00.000Z" },
      secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_after_seconds: 3600 }
    },
    credits: { has_credits: false, unlimited: false, balance: "0" }
  });
  assert.equal(parsed.planType, "pro");
  assert.equal(parsed.primary?.windowMinutes, 300);
  assert.equal(parsed.primary?.resetsAt, Date.parse("2026-05-10T12:00:00.000Z"));
  assert.equal(parsed.secondary?.windowMinutes, 10080);
  assert.equal(parsed.credits?.balance, 0);
});

function sampleAnalysis() {
  return {
    idea_summary: "A benchmark for local research agents.",
    problem_statement: "Research agents need evidence-gated evaluation.",
    domain_route: {
      key: "ai_llm_agent",
      label: "AI / LLM Agent",
      candidate_venues: ["NeurIPS"],
      rationale: "The idea evaluates agent workflows."
    },
    raw_score: {
      total: 60,
      rationale: "Promising but under-specified.",
      cap_reasons: ["missing verified related work"]
    },
    revised_score: {
      total: 82,
      rationale: "Revised plan includes evidence and baselines.",
      cap_reasons: []
    },
    feasibility: "Feasible with a small benchmark.",
    risks: ["Novelty collision risk."],
    related_work_queries: ["research agent benchmark 2026"],
    paper_clusters: [
      {
        name: "Agent benchmarks",
        core_problem: "Evaluating long-horizon agents",
        method_pattern: "Task suites and traces",
        representative_papers: ["TODO verified paper"],
        collision_risk: "medium",
        verification_queries: ["agent benchmark NeurIPS 2026"]
      }
    ],
    novelty_gaps: ["Need verified comparison against existing benchmarks."],
    revised_plan: {
      summary: "Build a benchmark with baselines, datasets, metrics, ablations, and failure cases.",
      key_changes: ["Add evidence matrix."],
      evidence_required: ["Verified related-work matrix."],
      feasibility: "Feasible"
    },
    experiment_plan: {
      baselines: ["baseline"],
      datasets: ["dataset"],
      metrics: ["metric"],
      ablations: ["ablation"],
      failure_cases: ["failure case"],
      reproducibility_checks: ["seeded runs"]
    },
    timeline: [
      {
        week: "1",
        deliverable: "Related-work matrix",
        exit_criteria: "At least one verified source"
      }
    ],
    reviewer_simulation: "Reviewer asks for stronger baselines.",
    artifact_contents: {}
  };
}

function sampleSearchPlan() {
  const query = (value: string) => ({ query: value, source_hints: ["openalex", "dblp"], purpose: "test" });
  return {
    core_concepts: ["agent", "benchmark"],
    synonyms: ["agent evaluation"],
    precision_queries: [query("p1"), query("p2"), query("p3"), query("p4"), query("p5")],
    recall_queries: [query("r1"), query("r2"), query("r3"), query("r4"), query("r5")],
    baseline_queries: [query("baseline")],
    dataset_metric_queries: [query("dataset metric")],
    venue_queries: [query("NeurIPS agent benchmark")],
    collision_queries: [query("agent benchmark prior work")],
    stop_condition: "enough candidates"
  };
}
