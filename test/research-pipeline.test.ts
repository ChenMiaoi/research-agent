import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sha256, type PdfManifestRecord } from "../src/skills/pdf/provenance.js";
import { buildPdfChunkIndex, type PdfChunkIndexEntry } from "../src/skills/pdf/chunk.js";
import { runResearchPipeline } from "../src/pipeline/research-pipeline.js";
import { createResearchPipelineState, markStage, readResearchPipelineState, writeResearchPipelineState } from "../src/pipeline/stage-state.js";
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
  assert.equal(result.state.stages.length, 14);
  const statuses = Object.fromEntries(result.state.stages.map((stage) => [stage.id, stage.status]));
  assert.equal(statuses.idea_intake, "completed");
  assert.equal(statuses.search_planning, "completed");
  assert.equal(statuses.literature_search, "completed");
  assert.equal(statuses.candidate_triage, "skipped");
  assert.equal(statuses.pdf_reading, "skipped");
  assert.equal(statuses.related_work_analysis, "skipped");
  assert.equal(statuses.ccf_a_strict_scoring, "completed");
  assert.equal(statuses.clarification_dialogue, "completed");
  assert.equal(statuses.venue_template_packaging, "completed");
  assert.equal(result.searchPlan.precision_queries.length >= 5, true);
  assert.equal(result.searchPlan.recall_queries.length >= 5, true);
  assert.equal(validateWithSchema<ResearchPipelineSchemaResult>(ResearchPipelineResultSchema, result, "ResearchPipelineResult"), result);
  assert.ok(result.artifacts["docs/relative_work/search_plan.json"]);
  assert.match(result.artifacts["docs/idea/raw_idea.md"] ?? "", /LLM agent benchmark/);
  assert.match(result.artifacts["docs/idea/optimized_research_direction.md"] ?? "", /Optimized Research Direction/);
  assert.match(result.artifacts["reports/ccf_a_readiness_report.md"] ?? "", /CCF-A Readiness Report/);
  assert.match(result.artifacts["reports/novelty_matrix.md"] ?? "", /Novelty Gap Matrix/);
  assert.match(result.artifacts["reports/related_work.md"] ?? "", /Related Work Report/);
  assert.match(result.artifacts["reports/evidence_ledger.md"] ?? "", /Evidence Ledger/);
  assert.match(result.artifacts["plans/12_week_execution_plan.md"] ?? "", /12 Week Execution Plan/);
  assert.match(result.artifacts["plans/experiment_plan.md"] ?? "", /Experiment Plan/);
  assert.equal(result.artifacts["docs/diagnosis/ccf_a_readiness_report.md"], result.artifacts["reports/ccf_a_readiness_report.md"]);
  assert.equal(result.artifacts["docs/execution_plan/12_week_plan.md"], result.artifacts["plans/12_week_execution_plan.md"]);
  assert.match(result.artifacts["paper/abstract.md"] ?? "", /Abstract Draft/);
  assert.match(result.artifacts["paper/related_work.md"] ?? "", /Related Work Draft/);
  assert.match(result.artifacts["papers/papers.bib"] ?? "", /Do not invent paper titles/);
  assert.ok(result.artifacts["docs/diagnosis/ccf_a_strict_scorecard.md"]?.includes("Strict mode: preliminary-only (CCF-A venue gate blocked)"));
  assert.ok(result.artifacts["docs/diagnosis/clarification_questions.md"]?.includes("Why it matters"));
  assert.ok(result.artifacts["docs/diagnosis/feasibility_report.md"]);
  assert.ok(result.artifacts["docs/proposal/revised_idea.md"]);
  assert.ok(result.artifacts["docs/submission/template_compliance_report.md"]?.includes("Status: passed"));
  assert.notEqual(result.artifacts["docs/submission/venue_template_profile.json"], "{}\n");
  assert.ok(result.artifacts["paper/main.tex"]);
  assert.ok(zipEntryNames(result.artifacts["paper/submission/overleaf.zip"] ?? "").includes("main.tex"));
  assert.ok(zipEntryNames(result.artifacts["paper/submission/submission.zip"] ?? "").includes("docs/submission/template_decision.md"));
  for (const stage of result.state.stages) {
    for (const artifact of stage.artifacts) assert.ok(Object.hasOwn(result.artifacts, artifact), `missing declared artifact ${stage.id}:${artifact}`);
  }
  assert.deepEqual(stageDefinition("venue_template_packaging").prompts, [
    "10_venue_template_selector.md",
    "11_latex_template_packager.md",
    "12_template_compliance_reviewer.md"
  ]);
});

test("research pipeline respects evidence gates for staged agents", async () => {
  const calls: string[] = [];
  const agent = {
    intakeIdea: async () => {
      calls.push("intakeIdea");
      return withAgentMeta({ idea_brief: sampleIdeaBrief() });
    },
    planLiteratureSearch: async () => {
      calls.push("planLiteratureSearch");
      return withAgentMeta({ search_plan: sampleSearchPlan() });
    },
    triagePaperCandidates: async () => {
      calls.push("triagePaperCandidates");
      return withAgentMeta({
        triage: {
          must_read_core_papers: [],
          expanded_papers: [],
          baselines: [],
          datasets: [],
          surveys: [],
          weakly_related: [],
          duplicates: [],
          missing_search_areas: ["offline search"],
          rationale: "No candidates in offline test."
        }
      });
    },
    readPaperPdf: async () => {
      calls.push("readPaperPdf");
      throw new Error("no chunks expected");
    },
    analyzeRelatedWork: async () => {
      calls.push("analyzeRelatedWork");
      return withAgentMeta({
        related_work: {
          topic_clusters: [],
          related_work_matrix_rows: [],
          reviewer_expected_baselines: [],
          evaluation_conventions: [],
          evidence_warnings: ["no verified notes"]
        }
      });
    },
    analyzeNovelty: async () => {
      calls.push("analyzeNovelty");
      return withAgentMeta({
        novelty: {
          collision_risk: "low" as const,
          collision_reasons: ["blocked by missing evidence"],
          novelty_gaps: ["read PDFs"],
          defensible_gap: "read PDFs first",
          evidence_warnings: ["no verified notes"]
        }
      });
    },
    scoreCcfA: async () => {
      calls.push("scoreCcfA");
      return withAgentMeta({ scorecard: { total: 45, dimensions: {}, cap_reasons: ["No PDF read"], evidence_warnings: [], recommendations: ["read PDFs"] } });
    },
    reviewFeasibility: async () => {
      calls.push("reviewFeasibility");
      return withAgentMeta({
        feasibility: {
          timeline_weeks: 12,
          feasible_mvp: ["verify literature"],
          ambitious_extensions: [],
          risks: ["missing evidence"],
          unavailable_resource_warnings: [],
          verdict: "feasible only after evidence collection"
        }
      });
    },
    refineIdea: async () => {
      calls.push("refineIdea");
      return withAgentMeta({
        strategy: {
          revised_idea: "Evidence-gated benchmark",
          central_hypothesis: "Evidence improves reviewer confidence.",
          baselines: [],
          datasets: [],
          metrics: [],
          ablations: [],
          failure_cases: [],
          first_4_week_plan: ["verify papers"],
          paper_story: "Evidence first."
        }
      });
    }
  };
  const result = await runResearchPipeline("Build an LLM agent benchmark.", {
    provider: "openai-codex",
    agentClient: agent,
    strictCcfA: true
  });
  assert.deepEqual(calls, ["intakeIdea", "planLiteratureSearch", "reviewFeasibility"]);
  assert.equal(result.searchPlan.precision_queries[0]?.query, "agent benchmark precision");
  assert.doesNotMatch(result.artifacts["docs/proposal/revised_idea.md"] ?? "", /Evidence-gated benchmark/);
  assert.equal(result.state.stages.find((stage) => stage.id === "better_idea_synthesis")?.status, "skipped");
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

test("research pipeline resumes completed stages from validated artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-resume-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const ideaBrief = {
      idea_summary: idea,
      problem: "benchmark",
      target_domain: "AI / LLM Agent",
      target_venues: ["NeurIPS"],
      method_keywords: ["agent"],
      task_keywords: ["benchmark"],
      evaluation_keywords: ["baseline"],
      resource_constraints: ["single researcher"],
      missing_information: [],
      assumptions: ["resume test"],
      search_seed_terms: ["agent", "benchmark"]
    };
    await writeArtifact(root, "docs/idea/idea_brief.md", `# Idea Brief\n\n${JSON.stringify(ideaBrief, null, 2)}\n`);
    await writeArtifact(root, "docs/idea/assumptions.md", "# Assumptions\n\n- resume test\n");
    await writeArtifact(root, "docs/relative_work/search_plan.json", JSON.stringify(sampleSearchPlan(), null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "idea_intake", "completed");
    state = markStage(state, "search_planning", "completed");
    await writeResearchPipelineState(root, state);

    const calls: string[] = [];
    const agent = {
      ...noEvidenceAgent(calls),
      planLiteratureSearch: async () => {
        calls.push("planLiteratureSearch");
        throw new Error("search planner should be resumed from artifact");
      }
    };
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: agent,
      strictCcfA: true
    });
    assert.equal(result.searchPlan.precision_queries[0]?.query, "agent benchmark precision");
    assert.equal(calls.includes("planLiteratureSearch"), false);
    assert.equal(result.state.stages.find((stage) => stage.id === "search_planning")?.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline repairs underspecified staged search plans", async () => {
  const calls: string[] = [];
  const agent = {
    ...noEvidenceAgent(calls),
    planLiteratureSearch: async () => {
      calls.push("planLiteratureSearch");
      return withAgentMeta({
        search_plan: {
          ...sampleSearchPlan(),
          precision_queries: [{ query: "too narrow", source_hints: ["openalex"], purpose: "test" }],
          recall_queries: [{ query: "too broad", source_hints: ["openalex"], purpose: "test" }]
        }
      });
    }
  };
  const result = await runResearchPipeline("Build an LLM agent benchmark.", {
    provider: "openai-codex",
    agentClient: agent,
    strictCcfA: true
  });
  assert.equal(result.searchPlan.precision_queries.length >= 5, true);
  assert.equal(result.searchPlan.recall_queries.length >= 5, true);
  assert.match(result.warnings.join("\n"), /Search planning gate repaired/);
});

test("research pipeline stage overrides force rerun and skip scheduled stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-stage-overrides-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const ideaBrief = sampleIdeaBrief();
    await writeArtifact(root, "docs/idea/idea_brief.md", `# Idea Brief\n\n${JSON.stringify(ideaBrief, null, 2)}\n`);
    await writeArtifact(root, "docs/idea/assumptions.md", "# Assumptions\n\n- override test\n");
    await writeArtifact(root, "docs/relative_work/search_plan.json", JSON.stringify(sampleSearchPlan(), null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "idea_intake", "completed");
    state = markStage(state, "search_planning", "completed");
    await writeResearchPipelineState(root, state);

    const calls: string[] = [];
    const events: Array<{ type: string; stage_id?: string; reason?: string }> = [];
    const agent = {
      ...noEvidenceAgent(calls),
      planLiteratureSearch: async () => {
        calls.push("planLiteratureSearch");
        return withAgentMeta({
          search_plan: {
            ...sampleSearchPlan(),
            precision_queries: [{ query: "forced rerun precision", source_hints: ["openalex"], purpose: "override test" }, ...sampleSearchPlan().precision_queries.slice(1)]
          }
        });
      },
      reviewFeasibility: async () => {
        calls.push("reviewFeasibility");
        throw new Error("feasibility should be skipped by stage override");
      }
    };
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: agent,
      strictCcfA: true,
      events: {
        emit: (event) => {
          events.push(event);
        }
      },
      stageOverrides: {
        fromStage: "search_planning",
        skipStages: { feasibility_review: "Operator accepted existing feasibility assessment." }
      }
    });

    assert.equal(calls.includes("planLiteratureSearch"), true);
    assert.equal(result.searchPlan.precision_queries[0]?.query, "forced rerun precision");
    assert.equal(calls.includes("reviewFeasibility"), false);
    assert.equal(result.state.stages.find((stage) => stage.id === "feasibility_review")?.status, "skipped");
    assert.match(result.state.stages.find((stage) => stage.id === "feasibility_review")?.error ?? "", /existing feasibility/);
    assert.ok(events.some((event) => event.type === "stage.started" && event.stage_id === "search_planning"));
    assert.ok(events.some((event) => event.type === "stage.skipped" && event.stage_id === "feasibility_review" && /existing feasibility/.test(event.reason ?? "")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline blocks candidate triage until eight core candidates exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-triage-gate-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    await writeArtifact(root, "docs/relative_work/candidates.json", JSON.stringify([
      {
        candidate_id: "paper-1",
        title: "Agent Benchmark Evaluation",
        authors: ["A. Researcher"],
        year: 2026,
        source_urls: ["https://example.test/paper"],
        pdf_urls: [],
        retrieval_sources: ["test"],
        retrieval_queries: ["agent benchmark"],
        confidence: "high"
      }
    ], null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/search_report.md", "# Search Report\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "literature_search", "completed");
    await writeResearchPipelineState(root, state);
    const calls: string[] = [];
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: noEvidenceAgent(calls),
      strictCcfA: true
    });
    assert.equal(calls.includes("triagePaperCandidates"), false);
    assert.equal(result.state.stages.find((stage) => stage.id === "candidate_triage")?.status, "skipped");
    assert.match(result.warnings.join("\n"), /Candidate triage gate blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline blocks resumed candidate triage below eight candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-triage-resume-gate-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    await writeArtifact(root, "docs/relative_work/candidates.json", JSON.stringify([
      {
        candidate_id: "paper-1",
        title: "Agent Benchmark Evaluation",
        authors: ["A. Researcher"],
        year: 2026,
        source_urls: ["https://example.test/paper"],
        pdf_urls: [],
        retrieval_sources: ["test"],
        retrieval_queries: ["agent benchmark"],
        confidence: "high"
      }
    ], null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/search_report.md", "# Search Report\n");
    await writeArtifact(root, "docs/relative_work/triage_report.md", "# STALE_TRIAGE\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "literature_search", "completed");
    state = markStage(state, "candidate_triage", "completed");
    await writeResearchPipelineState(root, state);
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.equal(result.state.stages.find((stage) => stage.id === "candidate_triage")?.status, "skipped");
    assert.doesNotMatch(result.artifacts["docs/relative_work/triage_report.md"] ?? "", /STALE_TRIAGE/);
    assert.match(result.warnings.join("\n"), /Candidate triage gate blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline blocks candidate triage when eight candidates are not CCF-A main track", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-ccf-gate-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const candidates = [
      pipelineCandidate("ccf-main-1", "Main Agent Benchmark", "NeurIPS"),
      ...Array.from({ length: 7 }, (_, index) => pipelineCandidate(`ccf-workshop-${index + 1}`, `Workshop Agent Benchmark ${index + 1}`, "NeurIPS Workshop"))
    ];
    await writeArtifact(root, "docs/relative_work/candidates.json", JSON.stringify(candidates, null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/search_report.md", "# Search Report\n\nEight raw candidates but only one CCF-A main track candidate.\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "literature_search", "completed");
    await writeResearchPipelineState(root, state);
    const calls: string[] = [];
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: noEvidenceAgent(calls),
      strictCcfA: true
    });
    assert.equal(calls.includes("triagePaperCandidates"), false);
    assert.equal(result.state.stages.find((stage) => stage.id === "candidate_triage")?.status, "skipped");
    assert.match(result.warnings.join("\n"), /qualified CCF-A main\/full core papers/);
    assert.match(result.artifacts["docs/diagnosis/ccf_a_strict_scorecard.md"] ?? "", /preliminary-only \(CCF-A venue gate blocked\)/);
    const persistedCandidates = JSON.parse(result.artifacts["docs/relative_work/candidates.json"] ?? "[]") as Array<{ ccf_gate_status?: string }>;
    assert.equal(persistedCandidates.filter((candidate) => candidate.ccf_gate_status === "included").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline keeps verified evidence runs preliminary when CCF-A gate is blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-ccf-preliminary-evidence-"));
  const idea = "Build an LLM agent benchmark.";
  const quote = "Verified gate evidence compares a baseline on a dataset with an accuracy metric and experiment plan.";
  try {
    await writeValidPdfProvenance(root, "ccf-main-1", `${quote} The paper also discusses limitations and reproducibility.`);
    const candidates = [
      pipelineCandidate("ccf-main-1", "Main Agent Benchmark", "NeurIPS", ["https://arxiv.org/pdf/ccf-main-1"]),
      ...Array.from({ length: 7 }, (_, index) => pipelineCandidate(`ccf-workshop-${index + 1}`, `Workshop Agent Benchmark ${index + 1}`, "NeurIPS Workshop"))
    ];
    await writeArtifact(root, "docs/relative_work/candidates.json", JSON.stringify(candidates, null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/search_report.md", "# Search Report\n\nVerified evidence exists, but the CCF-A venue gate is still below eight.\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "literature_search", "completed");
    state = markStage(state, "pdf_acquisition", "completed");
    await writeResearchPipelineState(root, state);
    const calls: string[] = [];
    const agent = {
      ...noEvidenceAgent(calls),
      readPaperPdf: async () => {
        calls.push("readPaperPdf");
        return withAgentMeta({
          paper_note: {
            paper_id: "ccf-main-1",
            title_verified: true,
            summary: "Verified gate evidence summary",
            main_problem: "Benchmark evaluation",
            core_method: "Evidence-gated benchmark",
            main_claims: [{ claim: "Uses baseline, dataset, metric, and experiment evidence.", evidence_quote: quote, page: 1, confidence: "high" as const }],
            datasets: ["dataset"],
            baselines: ["baseline"],
            metrics: ["accuracy metric"],
            strengths: [],
            weaknesses: [],
            limitations: ["limitation"],
            relevance_to_current_idea: "relevant",
            difference_from_current_idea: "different",
            collision_risk: "low" as const,
            useful_for: ["related work"],
            unreadable_or_missing_parts: []
          }
        });
      },
      analyzeRelatedWork: async () => {
        calls.push("analyzeRelatedWork");
        return withAgentMeta({
          related_work: {
            topic_clusters: [],
            related_work_matrix_rows: [],
            reviewer_expected_baselines: ["baseline"],
            evaluation_conventions: ["accuracy"],
            evidence_warnings: []
          }
        });
      },
      analyzeNovelty: async () => {
        calls.push("analyzeNovelty");
        throw new Error("novelty agent must be blocked by CCF-A venue gate");
      },
      scoreCcfA: async () => {
        calls.push("scoreCcfA");
        throw new Error("strict score agent must be blocked by CCF-A venue gate");
      },
      refineIdea: async () => {
        calls.push("refineIdea");
        throw new Error("strategy agent must be blocked by CCF-A venue gate");
      }
    };
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: agent,
      strictCcfA: true
    });
    assert.equal(calls.includes("readPaperPdf"), true);
    assert.equal(calls.includes("analyzeRelatedWork"), true);
    assert.equal(calls.includes("analyzeNovelty"), false);
    assert.equal(calls.includes("scoreCcfA"), false);
    assert.equal(calls.includes("refineIdea"), false);
    assert.equal(result.state.stages.find((stage) => stage.id === "novelty_analysis")?.status, "skipped");
    assert.equal(result.state.stages.find((stage) => stage.id === "better_idea_synthesis")?.status, "skipped");
    assert.match(result.artifacts["docs/diagnosis/ccf_a_strict_scorecard.md"] ?? "", /preliminary-only \(CCF-A venue gate blocked\)/);
    assert.match(result.artifacts["reports/ccf_a_readiness_report.md"] ?? "", /preliminary only; verified strict CCF-A path is blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline does not resume missing PDF files from manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-missing-pdf-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const manifest: PdfManifestRecord[] = [
      {
        paper_id: "missing-paper",
        pdf_path: "docs/reference/pdfs/missing-paper.pdf",
        pdf_sha256: "abc",
        source_url: "https://example.test/missing-paper.pdf",
        downloaded_at: "2026-05-11T00:00:00Z",
        bytes: 123,
        license_hint: "unknown",
        status: "downloaded"
      }
    ];
    await writeArtifact(root, "docs/reference/pdf_manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.match(result.warnings.join("\n"), /PDF acquisition resume ignored/);
    assert.deepEqual(JSON.parse(result.artifacts["docs/reference/pdf_manifest.json"] ?? "[]"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline rejects corrupt resumed PDF provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-corrupt-pdf-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const pdf = Buffer.from("%PDF-1.4\nAgent Benchmark Evaluation\n%%EOF\n", "latin1");
    await writeBinaryArtifact(root, "docs/reference/pdfs/paper-1.pdf", pdf);
    const manifest: PdfManifestRecord[] = [
      {
        paper_id: "paper-1",
        pdf_path: "docs/reference/pdfs/paper-1.pdf",
        pdf_sha256: "wrong-sha",
        source_url: "https://arxiv.org/pdf/1234.56789",
        downloaded_at: "2026-05-11T00:00:00Z",
        bytes: pdf.byteLength,
        license_hint: "arXiv",
        title_match_score: 1,
        status: "downloaded"
      }
    ];
    await writeArtifact(root, "docs/reference/pdf_manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.match(result.warnings.join("\n"), /provenance validation/);
    assert.deepEqual(JSON.parse(result.artifacts["docs/reference/pdf_manifest.json"] ?? "[]"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline requires mandatory PDF provenance fields on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-missing-provenance-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const pdf = Buffer.from("%PDF-1.4\nAgent Benchmark Evaluation\n%%EOF\n", "latin1");
    await writeBinaryArtifact(root, "docs/reference/pdfs/paper-1.pdf", pdf);
    const manifest = [
      {
        paper_id: "paper-1",
        pdf_path: "docs/reference/pdfs/paper-1.pdf",
        pdf_sha256: sha256(pdf),
        source_url: "https://arxiv.org/pdf/1234.56789",
        downloaded_at: "2026-05-11T00:00:00Z",
        bytes: pdf.byteLength,
        title_match_score: 1,
        status: "downloaded"
      }
    ] as unknown as PdfManifestRecord[];
    await writeArtifact(root, "docs/reference/pdf_manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.match(result.warnings.join("\n"), /provenance validation/);
    assert.deepEqual(JSON.parse(result.artifacts["docs/reference/pdf_manifest.json"] ?? "[]"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline ignores resumed chunks without validated PDF provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-unbacked-chunks-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const chunks = [
      {
        paper_id: "paper-1",
        chunk_id: "paper-1-p1-c1",
        page: 1,
        text: "unbacked stale chunk mentions a baseline, dataset, metric, and limitation"
      }
    ];
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(chunks, null, 2) + "\n");
    await writeArtifact(
      root,
      "docs/reference/paper_notes/paper-1.md",
      "# paper-1\n\n## Problem\n\nSTALE_NOTE\n\n## Claims And Evidence\n\n- Claim: stale\n  - Page: 1\n  - Quote: baseline\n  - Chunk: paper-1-p1-c1\n"
    );
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_reading", "completed");
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.match(result.warnings.join("\n"), /PDF reading resume ignored/);
    assert.deepEqual(JSON.parse(result.artifacts["docs/reference/pdf_chunks.json"] ?? "[]"), []);
    assert.equal(result.claimEvidenceRows.some((row) => row.status === "verified"), false);
    assert.equal(result.verifiedPapers.length, 0);
    assert.equal(Object.hasOwn(result.artifacts, "docs/reference/paper_notes/paper-1.md"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline ignores resumed chunks that do not match validated PDF bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-stale-chunks-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const parsedChunks = await writeValidPdfProvenance(root, "paper-1", "actual PDF evidence states a narrow limitation without the fabricated baseline claim.");
    const staleChunks = parsedChunks.map((chunk) => ({
      ...chunk,
      text: "fabricated stale chunk mentions a baseline, dataset, metric, and limitation that is not in the PDF"
    }));
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(staleChunks, null, 2) + "\n");
    await writeArtifact(root, "docs/diagnosis/ccf_a_strict_scorecard.md", "# STALE_SCORECARD\n\nFabricated stale score.\n");
    await writeArtifact(
      root,
      "docs/reference/paper_notes/paper-1.md",
      `# paper-1\n\n## Problem\n\nSTALE_NOTE\n\n## Method\n\nstale\n\n## Claims And Evidence\n\n- Claim: fabricated\n  - Page: ${staleChunks[0]!.page}\n  - Quote: fabricated stale chunk\n  - Chunk: ${staleChunks[0]!.chunk_id}\n\n## Limitations\n\nstale\n`
    );
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    state = markStage(state, "pdf_reading", "completed");
    state = markStage(state, "ccf_a_strict_scoring", "completed");
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.match(result.warnings.join("\n"), /PDF reading resume ignored/);
    assert.doesNotMatch(result.artifacts["docs/reference/pdf_chunks.json"] ?? "", /fabricated stale chunk/);
    assert.doesNotMatch(result.artifacts["docs/reference/paper_notes/paper-1.md"] ?? "", /STALE_NOTE/);
    assert.doesNotMatch(result.artifacts["docs/diagnosis/ccf_a_strict_scorecard.md"] ?? "", /STALE_SCORECARD/);
    assert.match(result.artifacts["docs/reference/pdf_chunks.json"] ?? "", /actual PDF evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline blocks downstream resume when paper notes are unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-resume-notes-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const chunks = await writeValidPdfProvenance(root, "paper-1", "unique resumed note evidence compares a baseline on a dataset with an accuracy metric and a limitation.");
    await writeArtifact(root, "docs/reference/paper_notes/README.md", "# Paper Notes\n\nResumed.\n");
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(chunks, null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    state = markStage(state, "pdf_reading", "completed");
    await writeResearchPipelineState(root, state);

    const calls: string[] = [];
    const agent = {
      ...noEvidenceAgent(calls),
      analyzeRelatedWork: async () => {
        calls.push("analyzeRelatedWork");
        throw new Error("missing full paper notes should block related-work agent");
      },
      refineIdea: async () => {
        calls.push("refineIdea");
        throw new Error("strategy should not run without related-work agent output");
      }
    };
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: agent,
      strictCcfA: true
    });
    assert.equal(calls.includes("analyzeRelatedWork"), false);
    assert.equal(calls.includes("refineIdea"), false);
    assert.equal(result.state.stages.find((stage) => stage.id === "related_work_analysis")?.status, "skipped");
    assert.equal(result.state.stages.find((stage) => stage.id === "better_idea_synthesis")?.status, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline preserves resumed paper note artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-preserve-notes-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const chunks = await writeValidPdfProvenance(root, "paper-1", "unique trusted analysis evidence compares a baseline on a dataset with an accuracy metric and a limitation.");
    const note = "# paper-1\n\n## Problem\n\nUNIQUE RESUMED NOTE\n\n## Method\n\nVerified method.\n\n## Claims And Evidence\n\n- Claim: preserved\n  - Page: 1\n  - Quote: unique\n  - Chunk: p1-c1\n\n## Limitations\n\nVerified limitation.\n";
    await writeArtifact(root, "docs/reference/paper_notes/README.md", "# Paper Notes\n\nResumed.\n");
    await writeArtifact(root, "docs/reference/paper_notes/paper-1.md", note);
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(chunks, null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    state = markStage(state, "pdf_reading", "completed");
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.match(result.artifacts["docs/reference/paper_notes/paper-1.md"] ?? "", /UNIQUE RESUMED NOTE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline rejects placeholder paper note artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-placeholder-notes-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const chunks = await writeValidPdfProvenance(root, "paper-1", "unique trusted analysis evidence compares a baseline on a dataset with an accuracy metric and a limitation.");
    await writeArtifact(root, "docs/reference/paper_notes/README.md", "# Paper Notes\n\nResumed.\n");
    await writeArtifact(root, "docs/reference/paper_notes/paper-1.md", "# paper-1\n\n## Problem\n\nPlaceholder without evidence refs.\n");
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(chunks, null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    state = markStage(state, "pdf_reading", "completed");
    await writeResearchPipelineState(root, state);

    const calls: string[] = [];
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: noEvidenceAgent(calls),
      strictCcfA: true
    });
    assert.equal(calls.includes("analyzeRelatedWork"), false);
    assert.equal(result.state.stages.find((stage) => stage.id === "related_work_analysis")?.status, "skipped");
    assert.doesNotMatch(result.artifacts["docs/reference/paper_notes/paper-1.md"] ?? "", /Placeholder without evidence refs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline distrusts stale downstream completed state without paper notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-stale-downstream-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const chunks = await writeValidPdfProvenance(root, "paper-1", "This benchmark paper compares a baseline on a dataset with an accuracy metric and a limitation.");
    await writeArtifact(root, "docs/reference/paper_notes/README.md", "# Paper Notes\n\nResumed.\n");
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(chunks, null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/related_work_matrix.csv", "paper_id,claim\npaper-1,stale\n");
    await writeArtifact(root, "docs/relative_work/topic_clusters.md", "# Stale Topic Clusters\n");
    await writeArtifact(root, "docs/relative_work/novelty_gap_matrix.md", "# Stale Novelty\n");
    await writeArtifact(root, "docs/relative_work/collision_risk.md", "# Stale Collision\n");
    await writeArtifact(root, "docs/proposal/revised_idea.md", "# Stale Strategy\n");
    await writeArtifact(root, "docs/proposal/experiment_plan.md", "# Stale Experiment Plan\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    state = markStage(state, "pdf_reading", "completed");
    state = markStage(state, "related_work_analysis", "completed");
    state = markStage(state, "novelty_analysis", "completed");
    state = markStage(state, "better_idea_synthesis", "completed");
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: noEvidenceAgent([]),
      strictCcfA: true
    });
    assert.equal(result.state.stages.find((stage) => stage.id === "related_work_analysis")?.status, "skipped");
    assert.equal(result.state.stages.find((stage) => stage.id === "novelty_analysis")?.status, "skipped");
    assert.equal(result.state.stages.find((stage) => stage.id === "better_idea_synthesis")?.status, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline rejects old strategy snapshots missing current artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-old-strategy-state-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const chunks = await writeValidPdfProvenance(root, "paper-1", "unique trusted strategy evidence compares a baseline on a dataset with an accuracy metric and a limitation.");
    const note = "# paper-1\n\n## Problem\n\nVerified problem.\n\n## Method\n\nVerified method.\n\n## Claims And Evidence\n\n- Claim: preserved\n  - Page: 1\n  - Quote: unique trusted strategy evidence\n  - Chunk: p1-c1\n\n## Limitations\n\nVerified limitation.\n";
    await writeArtifact(root, "docs/reference/paper_notes/README.md", "# Paper Notes\n\nResumed.\n");
    await writeArtifact(root, "docs/reference/paper_notes/paper-1.md", note);
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(chunks, null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/related_work_matrix.csv", "paper_id,claim\npaper-1,UNIQUE_MATRIX\n");
    await writeArtifact(root, "docs/relative_work/topic_clusters.md", "# UNIQUE_TOPIC\n");
    await writeArtifact(root, "docs/relative_work/novelty_gap_matrix.md", "# UNIQUE_NOVELTY\n");
    await writeArtifact(root, "docs/relative_work/collision_risk.md", "# UNIQUE_COLLISION\n");
    await writeArtifact(root, "docs/proposal/revised_idea.md", "# STALE_OLD_STRATEGY\n");
    await writeArtifact(root, "docs/proposal/experiment_plan.md", "# STALE_OLD_EXPERIMENT\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "pdf_acquisition", "completed");
    state = markStage(state, "pdf_reading", "completed");
    state = markStage(state, "related_work_analysis", "completed");
    state = markStage(state, "novelty_analysis", "completed");
    state = markStage(state, "better_idea_synthesis", "completed");
    state = {
      ...state,
      stages: state.stages.map((stage) =>
        stage.id === "better_idea_synthesis"
          ? { ...stage, artifacts: ["docs/proposal/revised_idea.md", "docs/proposal/experiment_plan.md"] }
          : stage
      )
    };
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.doesNotMatch(result.artifacts["docs/proposal/revised_idea.md"] ?? "", /STALE_OLD_STRATEGY/);
    assert.doesNotMatch(result.artifacts["docs/proposal/experiment_plan.md"] ?? "", /STALE_OLD_EXPERIMENT/);
    assert.equal(result.state.stages.find((stage) => stage.id === "better_idea_synthesis")?.status, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline preserves trusted resumed analysis artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-preserve-analysis-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const chunks = await writeValidPdfProvenance(root, "paper-1", "unique trusted analysis evidence compares a baseline on a dataset with an accuracy metric and a limitation.");
    const candidates = [
      pipelineCandidate("paper-1", "Preserved Main Agent Benchmark", "NeurIPS", ["https://arxiv.org/pdf/paper-1"]),
      ...Array.from({ length: 7 }, (_, index) => pipelineCandidate(`preserved-main-${index + 2}`, `Preserved Main Agent Benchmark ${index + 2}`, "NeurIPS"))
    ];
    const note = "# paper-1\n\n## Problem\n\nVerified problem.\n\n## Method\n\nVerified method.\n\n## Claims And Evidence\n\n- Claim: preserved\n  - Page: 1\n  - Quote: unique trusted analysis evidence\n  - Chunk: p1-c1\n\n## Limitations\n\nVerified limitation.\n";
    await writeArtifact(root, "docs/relative_work/candidates.json", JSON.stringify(candidates, null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/search_report.md", "# Search Report\n\nEight CCF-A main-track candidates allow strict analysis resume.\n");
    await writeArtifact(root, "docs/reference/paper_notes/README.md", "# Paper Notes\n\nResumed.\n");
    await writeArtifact(root, "docs/reference/paper_notes/paper-1.md", note);
    await writeArtifact(root, "docs/reference/pdf_chunks.json", JSON.stringify(chunks, null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/related_work_matrix.csv", "paper_id,claim\npaper-1,UNIQUE_MATRIX\n");
    await writeArtifact(root, "docs/relative_work/topic_clusters.md", "# UNIQUE_TOPIC\n");
    await writeArtifact(root, "docs/relative_work/novelty_gap_matrix.md", "# UNIQUE_NOVELTY\n");
    await writeArtifact(root, "docs/relative_work/collision_risk.md", "# UNIQUE_COLLISION\n");
    await writeArtifact(root, "docs/proposal/revised_idea.md", "# UNIQUE_STRATEGY\n");
    await writeArtifact(root, "docs/proposal/experiment_plan.md", "# UNIQUE_EXPERIMENT\n");
    await writeArtifact(root, "docs/proposal/first_4_week_plan.md", "# UNIQUE_FIRST_FOUR_WEEKS\n");
    await writeArtifact(root, "docs/proposal/paper_story.md", "# UNIQUE_PAPER_STORY\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "literature_search", "completed");
    state = markStage(state, "pdf_acquisition", "completed");
    state = markStage(state, "pdf_reading", "completed");
    state = markStage(state, "related_work_analysis", "completed");
    state = markStage(state, "novelty_analysis", "completed");
    state = markStage(state, "better_idea_synthesis", "completed");
    await writeResearchPipelineState(root, state);

    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "offline",
      strictCcfA: true
    });
    assert.match(result.artifacts["docs/relative_work/topic_clusters.md"] ?? "", /UNIQUE_TOPIC/);
    assert.match(result.artifacts["docs/relative_work/novelty_gap_matrix.md"] ?? "", /UNIQUE_NOVELTY/);
    assert.match(result.artifacts["docs/proposal/revised_idea.md"] ?? "", /UNIQUE_STRATEGY/);
    assert.match(result.artifacts["docs/proposal/first_4_week_plan.md"] ?? "", /UNIQUE_FIRST_FOUR_WEEKS/);
    assert.match(result.artifacts["docs/proposal/paper_story.md"] ?? "", /UNIQUE_PAPER_STORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research pipeline persists new staged PDF reader notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-pipeline-agent-notes-"));
  const idea = "Build an LLM agent benchmark.";
  try {
    const candidate = {
      candidate_id: "paper-1",
      title: "Agent Benchmark Evaluation",
      authors: ["A. Researcher"],
      year: 2026,
      source_urls: ["https://arxiv.org/abs/1234.56789"],
      pdf_urls: ["https://arxiv.org/pdf/1234.56789"],
      retrieval_sources: ["test"],
      retrieval_queries: ["agent benchmark"],
      confidence: "high" as const
    };
    const longText = `Agent Benchmark Evaluation ${"filler ".repeat(400)}baseline dataset metric limitation`;
    const pdf = Buffer.from(`%PDF-1.4\n/Type /Page\nstream\n${longText}\nendstream\n%%EOF\n`, "latin1");
    await writeBinaryArtifact(root, "docs/reference/pdfs/paper-1.pdf", pdf);
    await writeArtifact(root, "docs/relative_work/candidates.json", JSON.stringify([candidate], null, 2) + "\n");
    await writeArtifact(root, "docs/relative_work/search_report.md", "# Search Report\n");
    await writeArtifact(root, "docs/reference/pdf_manifest.json", JSON.stringify([
      {
        paper_id: "paper-1",
        pdf_path: "docs/reference/pdfs/paper-1.pdf",
        pdf_sha256: sha256(pdf),
        source_url: "https://arxiv.org/pdf/1234.56789",
        downloaded_at: "2026-05-11T00:00:00Z",
        bytes: pdf.byteLength,
        license_hint: "arXiv",
        title_match_score: 1,
        status: "downloaded"
      }
    ], null, 2) + "\n");
    let state = createResearchPipelineState(idea, root);
    state = markStage(state, "literature_search", "completed");
    state = markStage(state, "pdf_acquisition", "completed");
    await writeResearchPipelineState(root, state);

    const agent = {
      ...noEvidenceAgent([]),
      readPaperPdf: async () =>
        withAgentMeta({
          paper_note: {
            paper_id: "paper-1",
            title_verified: true,
            summary: "UNIQUE_AGENT_NOTE summary",
            main_problem: "UNIQUE_AGENT_NOTE problem",
            core_method: "UNIQUE_AGENT_NOTE method",
            main_claims: [{ claim: "UNIQUE_AGENT_NOTE claim", evidence_quote: "baseline dataset metric limitation", page: 1, confidence: "high" as const }],
            datasets: ["dataset"],
            baselines: ["baseline"],
            metrics: ["metric"],
            strengths: [],
            weaknesses: [],
            limitations: ["limitation"],
            relevance_to_current_idea: "relevant",
            difference_from_current_idea: "different",
            collision_risk: "low" as const,
            useful_for: ["related work"],
            unreadable_or_missing_parts: []
          }
        }),
      analyzeRelatedWork: async () =>
        withAgentMeta({
          related_work: {
            topic_clusters: [],
            related_work_matrix_rows: [],
            reviewer_expected_baselines: ["baseline"],
            evaluation_conventions: ["metric"],
            evidence_warnings: []
          }
        }),
      analyzeNovelty: async () =>
        withAgentMeta({
          novelty: {
            collision_risk: "low" as const,
            collision_reasons: ["different"],
            novelty_gaps: ["gap"],
            defensible_gap: "gap",
            evidence_warnings: []
          }
        }),
      scoreCcfA: async () => withAgentMeta({ scorecard: { total: 65, dimensions: {}, cap_reasons: [], evidence_warnings: [], recommendations: [] } }),
      refineIdea: async () =>
        withAgentMeta({
          strategy: {
            revised_idea: "strategy",
            central_hypothesis: "hypothesis",
            baselines: ["baseline"],
            datasets: ["dataset"],
            metrics: ["metric"],
            ablations: ["ablation"],
            failure_cases: ["failure"],
            first_4_week_plan: ["week 1"],
            paper_story: "story"
          }
        })
    };
    const result = await runResearchPipeline(idea, {
      outputRoot: root,
      provider: "openai-codex",
      agentClient: agent,
      strictCcfA: true
    });
    assert.match(result.artifacts["docs/reference/paper_notes/paper-1.md"] ?? "", /UNIQUE_AGENT_NOTE/);
    assert.match(result.artifacts["docs/reference/paper_notes/paper-1.md"] ?? "", /Chunk: p1-c2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function withAgentMeta<T extends object>(value: T): T & { provider_id: string; api_shape: string; codex_model: string; events: unknown[] } {
  return { ...value, provider_id: "openai-codex", api_shape: "openai-codex-responses", codex_model: "test", events: [] };
}

function noEvidenceAgent(calls: string[]) {
  return {
    intakeIdea: async () => {
      calls.push("intakeIdea");
      return withAgentMeta({ idea_brief: sampleIdeaBrief() });
    },
    planLiteratureSearch: async () => {
      calls.push("planLiteratureSearch");
      return withAgentMeta({ search_plan: sampleSearchPlan() });
    },
    triagePaperCandidates: async () => {
      calls.push("triagePaperCandidates");
      return withAgentMeta({
        triage: {
          must_read_core_papers: [],
          expanded_papers: [],
          baselines: [],
          datasets: [],
          surveys: [],
          weakly_related: [],
          duplicates: [],
          missing_search_areas: ["offline search"],
          rationale: "No candidates in offline test."
        }
      });
    },
    readPaperPdf: async () => {
      calls.push("readPaperPdf");
      throw new Error("no chunks expected");
    },
    analyzeRelatedWork: async () => {
      calls.push("analyzeRelatedWork");
      throw new Error("related work should be evidence-gated");
    },
    analyzeNovelty: async () => {
      calls.push("analyzeNovelty");
      throw new Error("novelty should be evidence-gated");
    },
    scoreCcfA: async () => {
      calls.push("scoreCcfA");
      throw new Error("agent scoring should be evidence-gated");
    },
    reviewFeasibility: async () => {
      calls.push("reviewFeasibility");
      return withAgentMeta({
        feasibility: {
          timeline_weeks: 12,
          feasible_mvp: ["verify literature"],
          ambitious_extensions: [],
          risks: ["missing evidence"],
          unavailable_resource_warnings: [],
          verdict: "feasible only after evidence collection"
        }
      });
    },
    refineIdea: async () => {
      calls.push("refineIdea");
      throw new Error("strategy should be evidence-gated");
    }
  };
}

function sampleIdeaBrief() {
  return {
    idea_summary: "Build an LLM agent benchmark.",
    problem: "agent evaluation",
    target_domain: "AI / LLM Agent",
    target_venues: ["NeurIPS"],
    method_keywords: ["agent"],
    task_keywords: ["benchmark"],
    evaluation_keywords: ["baseline", "dataset", "metric"],
    resource_constraints: ["single researcher"],
    missing_information: [],
    assumptions: ["test"],
    search_seed_terms: ["agent", "benchmark"]
  };
}

function sampleSearchPlan() {
  const query = (value: string) => ({ query: value, source_hints: ["openalex", "dblp"], purpose: "test" });
  return {
    core_concepts: ["agent", "benchmark"],
    synonyms: ["agent evaluation"],
    precision_queries: [query("agent benchmark precision"), query("p2"), query("p3"), query("p4"), query("p5")],
    recall_queries: [query("r1"), query("r2"), query("r3"), query("r4"), query("r5")],
    baseline_queries: [query("baseline")],
    dataset_metric_queries: [query("dataset metric")],
    venue_queries: [query("NeurIPS agent benchmark")],
    collision_queries: [query("agent benchmark prior work")],
    stop_condition: "enough candidates"
  };
}

function pipelineCandidate(candidateId: string, title: string, venue: string, pdfUrls: string[] = []) {
  return {
    candidate_id: candidateId,
    title,
    authors: ["A. Researcher"],
    year: 2026,
    venue,
    source_urls: [`https://example.test/${candidateId}`],
    pdf_urls: pdfUrls,
    retrieval_sources: ["test"],
    retrieval_queries: ["agent benchmark"],
    confidence: "high" as const
  };
}

async function writeArtifact(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeBinaryArtifact(root: string, relativePath: string, content: Buffer): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeValidPdfProvenance(root: string, paperId: string, text: string): Promise<PdfChunkIndexEntry[]> {
  const pdf = Buffer.from(`%PDF-1.4\n/Type /Page\nstream\n${text}\nendstream\n%%EOF\n`, "latin1");
  await writeBinaryArtifact(root, `docs/reference/pdfs/${paperId}.pdf`, pdf);
  const manifest: PdfManifestRecord[] = [
    {
      paper_id: paperId,
      pdf_path: `docs/reference/pdfs/${paperId}.pdf`,
      pdf_sha256: sha256(pdf),
      source_url: `https://arxiv.org/pdf/${paperId}`,
      downloaded_at: "2026-05-11T00:00:00Z",
      bytes: pdf.byteLength,
      license_hint: "arXiv",
      title_match_score: 1,
      status: "downloaded"
    }
  ];
  await writeArtifact(root, "docs/reference/pdf_manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return await buildPdfChunkIndex(root, manifest);
}

function zipEntryNames(artifact: string): string[] {
  const buffer = Buffer.from(artifact, "latin1");
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    names.push(buffer.subarray(nameStart, nameEnd).toString("utf8"));
    offset = nameEnd + extraLength + compressedSize;
  }
  return names;
}
