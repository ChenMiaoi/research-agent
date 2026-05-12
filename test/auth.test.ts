import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentPrompt } from "../src/agents/agent-runner.js";
import { validatePdfPaperNote, validateStrictCcfAReview } from "../src/agents/schemas.js";
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

test("strict CCF-A reviewer prompt and schema use the canonical rubric", async () => {
  const prompt = await loadAgentPrompt("06_ccf_a_reviewer.md");
  for (const expected of [
    "problem_significance / Problem Significance: 10",
    "novelty / Novelty: 20",
    "technical_depth / Technical Depth: 15",
    "method_clarity / Method Clarity: 10",
    "experimental_rigor / Experimental Rigor: 20",
    "related_work / Related Work: 10",
    "feasibility_reproducibility / Feasibility / Reproducibility: 10",
    "venue_story / Venue / Story: 5",
    "No verified related work: total score cannot exceed 45",
    "No CCF-A core papers: total score cannot exceed 55",
    "No baseline/dataset/metric: total score cannot exceed 60",
    "Engineering artifact without research question: total score cannot exceed 50",
    "High prior-work collision: total score cannot exceed 40",
    "No executable experiment plan: total score cannot exceed 65"
  ]) {
    assert.match(prompt, new RegExp(escapeRegExp(expected)));
  }
  assert.doesNotMatch(prompt, /Problem importance|Experimental design: 15|Venue fit: 10|Paper story: 5|Fewer than 5 core related papers/);

  const valid = validateStrictCcfAReview({
    total: 65,
    dimensions: {
      problem_significance: 8,
      novelty: 12,
      technical_depth: 10,
      method_clarity: 7,
      experimental_rigor: 13,
      related_work: 6,
      feasibility_reproducibility: 6,
      venue_story: 3
    },
    cap_reasons: [],
    evidence_warnings: [],
    recommendations: []
  });
  assert.equal(valid.dimensions.experimental_rigor, 13);

  assert.throws(
    () =>
      validateStrictCcfAReview({
        total: 50,
        dimensions: { novelty_after_related_work: 10 },
        cap_reasons: [],
        evidence_warnings: [],
        recommendations: []
      }),
    /StrictCcfAReview/
  );
});

test("PDF paper reader prompt and schema require page quote and chunk id", async () => {
  const prompt = await loadAgentPrompt("03_pdf_paper_reader.md");
  assert.match(prompt, /page number, exact quote, and the source `chunk_id`/);
  assert.match(prompt, /page\/quote\/chunk_id\/confidence/);

  const valid = {
    paper_id: "paper-1",
    title_verified: true,
    summary: "summary",
    main_problem: "problem",
    core_method: "method",
    main_claims: [{ claim: "claim", evidence_quote: "quote", page: 1, chunk_id: "p1-c1", confidence: "high" }],
    datasets: [],
    baselines: [],
    metrics: [],
    strengths: [],
    weaknesses: [],
    limitations: [],
    relevance_to_current_idea: "relevant",
    difference_from_current_idea: "different",
    collision_risk: "low",
    useful_for: [],
    unreadable_or_missing_parts: []
  };
  assert.equal(validatePdfPaperNote(valid).main_claims[0]?.chunk_id, "p1-c1");
  assert.throws(() => validatePdfPaperNote({ ...valid, main_claims: [{ claim: "claim", evidence_quote: "quote", page: 1, confidence: "high" }] }), /chunk_id/);
});

test("staged reviewer prompts enforce reviewer identities and mandatory task limits", async () => {
  const prompts = [
    ["09_reviewer_novelty_related_work.md", "R1", "Novelty / Related Work"],
    ["10_reviewer_method_experiment.md", "R2", "Method / Experiment"],
    ["11_reviewer_venue_story.md", "R3", "Venue / Story"]
  ] as const;
  for (const [file, reviewerId, role] of prompts) {
    const prompt = await loadAgentPrompt(file);
    assert.match(prompt, new RegExp(`reviewer_id.*${reviewerId}|${reviewerId}.*reviewer_id`, "i"));
    assert.match(prompt, new RegExp(role.replace("/", "\\/")));
    assert.match(prompt, /Do not change deterministic score caps or remove required tasks/i);
    assert.match(prompt, /verdict, summary, major concerns, required evidence, questions/i);
  }
});

test("CodexOAuthClient rethrows cancellation during JSON body reads", async () => {
  const home = await mkdtemp(join(tmpdir(), "idea2repo-oauth-cancel-"));
  const previous = process.env.IDEA2REPO_HOME;
  process.env.IDEA2REPO_HOME = home;
  const controller = new AbortController();
  try {
    const storage = new AuthStorage();
    await storage.set("openai-codex", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "account-id"
    });
    const response = new Response(JSON.stringify({ project_name: "cancelled-project" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    const readText = response.text.bind(response);
    Object.defineProperty(response, "text", {
      value: async () => {
        const text = await readText();
        controller.abort("oauth body cancelled");
        return text;
      }
    });
    const client = new CodexOAuthClient({
      storage,
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        assert.equal(init?.signal, controller.signal);
        return response;
      },
      maxRetries: 0
    });
    await assert.rejects(client.suggestProjectName("cancel during body"), /oauth body cancelled/);
  } finally {
    if (previous == null) delete process.env.IDEA2REPO_HOME;
    else process.env.IDEA2REPO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("CodexOAuthClient rethrows cancellation during usage JSON reads", async () => {
  const home = await mkdtemp(join(tmpdir(), "idea2repo-usage-cancel-"));
  const previous = process.env.IDEA2REPO_HOME;
  process.env.IDEA2REPO_HOME = home;
  const controller = new AbortController();
  try {
    const storage = new AuthStorage();
    await storage.set("openai-codex", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "account-id"
    });
    const response = new Response(JSON.stringify({ data: { rate_limits: { primary: { usedPercent: 1 } } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    const readJson = response.json.bind(response);
    Object.defineProperty(response, "json", {
      value: async () => {
        const json = await readJson();
        controller.abort("usage body cancelled");
        return json;
      }
    });
    const client = new CodexOAuthClient({
      storage,
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        assert.equal(init?.signal, controller.signal);
        return response;
      },
      maxRetries: 0
    });
    await assert.rejects(client.getUsage(), /usage body cancelled/);
  } finally {
    if (previous == null) delete process.env.IDEA2REPO_HOME;
    else process.env.IDEA2REPO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("CodexOAuthClient rethrows cancellation while waiting for the auth lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "idea2repo-lock-cancel-"));
  const previous = process.env.IDEA2REPO_HOME;
  process.env.IDEA2REPO_HOME = home;
  const controller = new AbortController();
  try {
    const storage = new AuthStorage();
    await storage.set("openai-codex", {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "account-id"
    });
    await storage.withLock(async () => {
      const client = new CodexOAuthClient({
        storage,
        signal: controller.signal,
        fetchImpl: async () => new Response(JSON.stringify({ project_name: "should-not-run" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
        maxRetries: 0
      });
      const pending = assert.rejects(client.suggestProjectName("cancel during lock"), /auth lock cancelled/);
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort("auth lock cancelled");
      await pending;
    });
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
