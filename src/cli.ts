import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { buildGithubExportPlan, publishWithGh } from "./github-export.js";
import { generateResearchRepo, resumeResearchRepo, type GenerateOptions } from "./generator.js";
import { searchLiteratureAsync } from "./literature.js";
import { PermissionDeniedError, type PermissionPolicy } from "./permissions.js";
import { canonicalProvider, providerSchema, safeProviderReport } from "./providers.js";
import { ensureChild, exists, readManifest, status as projectStatus, validate as validateProject, writeText } from "./state.js";
import { loadVenueDatabase, validateVenueDatabase } from "./venues.js";
import { inspectWorkspace } from "./workspace.js";
import { startApiServer } from "./api.js";
import { AuthStorage, openaiCodexOAuthProvider } from "./auth/codex-oauth.js";
import { runTui } from "./tui/App.js";
import { loadCodexModelCatalog } from "./models.js";
import { proxyEnvForChild } from "./proxy.js";
import { runResearchPipeline } from "./pipeline/research-pipeline.js";
import { formatDecisions, readDecisionRecords } from "./runtime/decisions.js";
import { JsonlEventSink, readJsonlEvents } from "./runtime/events.js";
import { formatPlan, readPlanState } from "./runtime/plan.js";
import { formatSnapshots, listArtifactSnapshots, restoreArtifactSnapshot } from "./runtime/artifacts.js";
import { appendScoreSnapshot, ensureRuntimeLedgers, evidenceItemsFromRows, replaceEvidenceItems, scoreSnapshotFromStrictScore } from "./runtime/ledgers.js";
import { retryRuntimeStage, skipRuntimeStage } from "./runtime/runs.js";
import type { ResearchStageId } from "./pipeline/stages.js";
import { createProviderAdapter } from "./providers/index.js";
import { normalizeSources } from "./skills/literature/search.js";
import type { LiteratureSource } from "./skills/literature/types.js";
import { acquirePdfs } from "./skills/pdf/acquire.js";
import { buildPdfChunkIndex } from "./skills/pdf/chunk.js";
import type { PdfChunkIndexEntry } from "./skills/pdf/chunk.js";
import type { PdfManifestRecord } from "./skills/pdf/provenance.js";
import { rebuildTrustedPdfChunks } from "./skills/pdf/trust.js";
import type { PaperCandidate } from "./skills/literature/types.js";
import { evidenceRowsMarkdown, evidenceText, extractEvidenceRows, evidenceRowsCsv, trustedEvidenceRows } from "./skills/analysis/evidence-extract.js";
import { relatedWorkMatrixCsv, topicClustersMarkdown } from "./skills/analysis/related-work-matrix.js";
import { assessNovelty, noveltyMatrixMarkdown } from "./skills/analysis/novelty-matrix.js";
import { strictCcfAScore, strictScoreMarkdown } from "./skills/analysis/ccf-a-score.js";
import { experimentPlanMarkdown, feasibilityMarkdown, revisedIdeaMarkdown } from "./skills/analysis/idea-refine.js";
import { loadTemplateProfiles, validateTemplateProfiles } from "./skills/templates/catalog.js";
import { resolveTemplateProfile, templateDecisionMarkdown } from "./skills/templates/resolve.js";
import { renderPaper } from "./skills/templates/render.js";
import { anonymityMarkdown, checkTemplateCompliance, complianceMarkdown } from "./skills/templates/compliance.js";
import { compilePaper } from "./skills/templates/compile.js";
import { packagePaper } from "./skills/templates/package.js";
import type { ReviewMode, TemplateResolveInput, VenueTemplateProfile } from "./skills/templates/types.js";

const commandNames = new Set(["research", "generate", "plan", "trace", "stage", "snapshots", "restore", "literature", "papers", "score", "refine", "templates", "paper", "status", "resume", "validate", "doctor", "auth", "login", "logout", "provider", "venues", "github", "api", "web"]);

type ParsedArgs = {
  _: string[];
  flags: Map<string, string[]>;
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (!argv.length) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runTui();
        return 0;
      }
      printHelp();
      return 0;
    }
    if (argv[0] === "-h" || argv[0] === "--help") {
      printHelp();
      return 0;
    }
    const command = commandNames.has(argv[0] ?? "") ? argv[0]! : "generate";
    const rest = command === "generate" && !commandNames.has(argv[0] ?? "") ? argv : argv.slice(1);
    switch (command) {
      case "generate":
        return await commandGenerate(rest, false);
      case "research":
        return await commandGenerate(rest, true);
      case "plan":
        return await commandPlan(rest);
      case "trace":
        return await commandTrace(rest);
      case "stage":
        return await commandStage(rest);
      case "snapshots":
        return await commandSnapshots(rest);
      case "restore":
        return await commandRestore(rest);
      case "literature":
        return await commandLiterature(rest);
      case "papers":
        return await commandPapers(rest);
      case "score":
        return await commandScore(rest);
      case "refine":
        return await commandRefine(rest);
      case "templates":
        return await commandTemplates(rest);
      case "paper":
        return await commandPaper(rest);
      case "status":
        return await commandStatus(rest);
      case "resume":
        return await commandResume(rest);
      case "validate":
        return await commandValidate(rest);
      case "doctor":
        return await commandDoctor(rest);
      case "auth":
        return await commandAuth(rest);
      case "login":
        return await commandAuth(["login", ...rest]);
      case "logout":
        return await commandAuth(["logout", ...rest]);
      case "provider":
        return await commandProvider(rest);
      case "venues":
        return commandVenues(rest);
      case "github":
        return await commandGithub(rest);
      case "api":
        return await commandApi(rest);
      case "web":
        return await commandWeb(rest);
      default:
        console.error(`error: unknown command: ${command}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof PermissionDeniedError || error instanceof Error) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    console.error("error: unknown failure");
    return 2;
  }
}

async function commandPlan(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  console.log(formatPlan(await readPlanState(root)));
  return 0;
}

async function commandTrace(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  if (hasFlag(parsed, "decisions")) {
    console.log(formatDecisions(await readDecisionRecords(root)));
    return 0;
  }
  const limit = numberFlag(parsed, "limit", 20);
  const events = await readJsonlEvents(ensureChild(root, ".idea2repo/trace.jsonl"));
  for (const event of events.slice(-limit)) console.log(JSON.stringify(event));
  return 0;
}

async function commandStage(argv: string[]): Promise<number> {
  const action = argv[0] ?? "";
  const stageId = argv[1] as ResearchStageId | undefined;
  const parsed = parseArgs(argv.slice(2));
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  if (!stageId) throw new Error("stage_id is required");
  if (action === "skip") {
    const reason = stringFlag(parsed, "reason") ?? parsed._.join(" ").trim();
    const result = await skipRuntimeStage(root, stageId, reason);
    console.log(`Stage skipped: ${result.stage_id}`);
    console.log(`Run: ${result.run_id}`);
    return 0;
  }
  if (action === "retry") {
    const reason = stringFlag(parsed, "reason") ?? parsed._.join(" ").trim();
    const result = await retryRuntimeStage(root, stageId, {
      reason: reason || undefined,
      execute: !hasFlag(parsed, "no-execute"),
      allowNetwork: hasFlag(parsed, "allow-network"),
      downloadPdfs: hasFlag(parsed, "download-pdfs"),
      maxPapers: numberFlag(parsed, "max-papers", 20)
    });
    console.log(`Stage retry ${result.executed ? "executed" : "prepared"}: ${result.stage_id}`);
    console.log(`Snapshots: ${result.snapshots.length}`);
    console.log(`Run: ${result.run_id}`);
    return 0;
  }
  throw new Error(`unknown stage action: ${action || "(missing)"}`);
}

async function commandSnapshots(argv: string[]): Promise<number> {
  const action = argv[0] ?? "list";
  const parsed = parseArgs(argv.slice(1));
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  if (action !== "list") throw new Error(`unknown snapshots action: ${action}`);
  console.log(formatSnapshots(await listArtifactSnapshots(root)));
  return 0;
}

async function commandRestore(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  const restored = await restoreArtifactSnapshot(root, {
    snapshotId: stringFlag(parsed, "snapshot") ?? undefined,
    artifactPath: stringFlag(parsed, "artifact") ?? undefined,
    events: new JsonlEventSink(ensureChild(root, ".idea2repo/trace.jsonl"))
  });
  console.log(`Restored ${restored.path} from snapshot ${restored.id}`);
  return 0;
}

async function commandPapers(argv: string[]): Promise<number> {
  const action = argv[0] ?? "analyze";
  const parsed = parseArgs(argv.slice(1));
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  if (action !== "analyze") throw new Error(`unknown papers action: ${action}`);
  const candidates = await readJsonFile<PaperCandidate[]>(root, "docs/relative_work/candidates.json", []);
  const { manifest, chunks, warnings } = await trustedPdfChunksFromProject(root);
  const evidenceRows = extractEvidenceRows(chunks);
  const runId = "cli-analysis";
  await ensureRuntimeLedgers(root);
  await replaceEvidenceItems(root, { runId, stageId: "pdf_reading" }, evidenceItemsFromRows({ runId, stageId: "pdf_reading", rows: evidenceRows, candidates, manifest, chunks }));
  await writeText(ensureChild(root, "docs/reference/pdf_chunks.json"), JSON.stringify(chunks, null, 2) + "\n");
  await writeText(ensureChild(root, "docs/reference/claim_evidence_matrix.csv"), evidenceRowsCsv(evidenceRows, chunks));
  for (const [relativePath, content] of Object.entries(evidenceRowsMarkdown(evidenceRows, chunks))) await writeText(ensureChild(root, relativePath), content);
  await writeText(ensureChild(root, "docs/relative_work/related_work_matrix.csv"), relatedWorkMatrixCsv(candidates, manifest, evidenceRows, chunks, { verifiedOnly: true }));
  const backedCandidates = evidenceBackedCandidates(candidates, evidenceRows, chunks);
  await writeText(ensureChild(root, "docs/relative_work/topic_clusters.md"), topicClustersMarkdown(backedCandidates));
  const novelty = assessNovelty(await ideaFromArgsOrManifest(parsed, root), backedCandidates, evidenceRows, chunks);
  await writeText(ensureChild(root, "docs/relative_work/novelty_gap_matrix.md"), noveltyMatrixMarkdown(novelty));
  await writeText(ensureChild(root, "docs/relative_work/collision_risk.md"), `# Collision Risk\n\n${novelty.collision_risk}\n\n${novelty.reasons.map((reason) => `- ${reason}`).join("\n")}\n`);
  console.log(`Paper analysis written under ${ensureChild(root, "docs/relative_work")}`);
  console.log(`Evidence rows: ${evidenceRows.length}`);
  if (warnings.length) console.log(`Warnings: ${warnings.length}`);
  return 0;
}

async function commandScore(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  const idea = await ideaFromArgsOrManifest(parsed, root);
  const candidates = await readJsonFile<PaperCandidate[]>(root, "docs/relative_work/candidates.json", []);
  const { manifest, chunks, warnings } = await trustedPdfChunksFromProject(root);
  const evidenceRows = extractEvidenceRows(chunks);
  const runId = "cli-analysis";
  const evidenceItems = evidenceItemsFromRows({ runId, stageId: "pdf_reading", rows: evidenceRows, candidates, manifest, chunks });
  const text = evidenceText(evidenceRows);
  const novelty = assessNovelty(idea, candidates, evidenceRows);
  const verifiedPaperCount = verifiedEvidencePaperCount(evidenceRows);
  const score = strictCcfAScore({
    verifiedRelatedWorkCount: verifiedPaperCount,
    pdfReadCount: new Set(chunks.map((chunk) => chunk.paper_id)).size,
    corePaperCount: verifiedPaperCount,
    evidenceRefs: evidenceItems.map((item) => item.id),
    hasStrongBaseline: text.includes("baseline"),
    hasDatasetOrBenchmark: text.includes("dataset") || text.includes("benchmark"),
    hasMetric: text.includes("metric") || text.includes("accuracy") || text.includes("latency"),
    highPriorWorkCollision: novelty.collision_risk === "high",
    pureEngineeringIntegration: /tool|platform|dashboard|repo/.test(text),
    hasScientificHypothesis: text.includes("hypothesis") || text.includes("claim"),
    hasExecutableExperimentPlan: text.includes("experiment") && text.includes("baseline") && text.includes("metric"),
    singlePersonTwelveWeekInfeasible: valuesFlag(parsed, "resource").some((resource) => /single|solo|one/i.test(resource)) && numberFlag(parsed, "weeks", 12) <= 12,
    venueRequiresThreatModel: /ccs|security|s&p|ndss/i.test(stringFlag(parsed, "venue") ?? ""),
    hasThreatModel: text.includes("threat model"),
    venueRequiresSystemEvaluation: /osdi|sosp|sigcomm|atc|systems/i.test(stringFlag(parsed, "venue") ?? ""),
    hasPrototype: text.includes("prototype"),
    venueExpectsStrongMlBaselines: /neurips|icml|iclr|acl/i.test(stringFlag(parsed, "venue") ?? ""),
    hasStrongMlBaselines: text.includes("baseline")
  });
  await ensureRuntimeLedgers(root);
  await replaceEvidenceItems(root, { runId, stageId: "pdf_reading" }, evidenceItems);
  await appendScoreSnapshot(root, scoreSnapshotFromStrictScore({
    runId,
    stageId: "ccf_a_strict_scoring",
    score,
    evidenceRefs: evidenceItems.map((item) => item.id)
  }));
  if (warnings.length) console.log(`Warnings: ${warnings.length}`);
  await writeText(ensureChild(root, "docs/diagnosis/ccf_a_strict_scorecard.md"), strictScoreMarkdown(score));
  console.log(`Strict CCF-A score: ${score.total} / 100`);
  console.log(`Scorecard written: ${ensureChild(root, "docs/diagnosis/ccf_a_strict_scorecard.md")}`);
  return 0;
}

async function commandRefine(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  const idea = await ideaFromArgsOrManifest(parsed, root);
  const candidates = await readJsonFile<PaperCandidate[]>(root, "docs/relative_work/candidates.json", []);
  const { chunks, warnings } = await trustedPdfChunksFromProject(root);
  const evidenceRows = extractEvidenceRows(chunks);
  const novelty = assessNovelty(idea, candidates, evidenceRows);
  const verifiedPaperCount = verifiedEvidencePaperCount(evidenceRows);
  const text = evidenceText(evidenceRows);
  const score = strictCcfAScore({
    verifiedRelatedWorkCount: verifiedPaperCount,
    pdfReadCount: new Set(chunks.map((chunk) => chunk.paper_id)).size,
    corePaperCount: verifiedPaperCount,
    hasStrongBaseline: text.includes("baseline"),
    hasDatasetOrBenchmark: text.includes("dataset") || text.includes("benchmark"),
    hasMetric: text.includes("metric") || text.includes("accuracy") || text.includes("latency"),
    highPriorWorkCollision: novelty.collision_risk === "high",
    hasExecutableExperimentPlan: false
  });
  if (warnings.length) console.log(`Warnings: ${warnings.length}`);
  await writeText(ensureChild(root, "docs/proposal/revised_idea.md"), revisedIdeaMarkdown(idea, novelty, score));
  await writeText(ensureChild(root, "docs/proposal/experiment_plan.md"), experimentPlanMarkdown());
  await writeText(ensureChild(root, "docs/diagnosis/feasibility_report.md"), feasibilityMarkdown(valuesFlag(parsed, "resource"), numberFlag(parsed, "weeks", 12)));
  console.log(`Revised idea written: ${ensureChild(root, "docs/proposal/revised_idea.md")}`);
  return 0;
}

async function commandTemplates(argv: string[]): Promise<number> {
  const action = argv[0] ?? "list";
  const parsed = parseArgs(argv.slice(1));
  if (action === "list") {
    for (const profile of loadTemplateProfiles()) {
      console.log(`${profile.profile_id}\t${profile.venue_key}\t${profile.template_family}\t${profile.venue_name}`);
    }
    return 0;
  }
  if (action === "validate") {
    const errors = validateTemplateProfiles();
    if (errors.length) {
      for (const error of errors) console.error(error);
      return 1;
    }
    console.log(`Template profiles valid: ${loadTemplateProfiles().length}`);
    return 0;
  }
  if (action === "show") {
    const venueArg = stringFlag(parsed, "venue") ?? (parsed._.join(" ").trim() || undefined);
    const year = optionalNumberFlag(parsed, "year");
    const input = {
      venue: venueArg,
      domain: stringFlag(parsed, "domain") ?? undefined,
      family: stringFlag(parsed, "family") ?? undefined,
      year,
      mode: normalizeTemplateMode(stringFlag(parsed, "mode") ?? stringFlag(parsed, "review-mode")),
      paperType: stringFlag(parsed, "paper-type") ?? undefined
    };
    const result = await resolveTemplateProfile(input);
    console.log(JSON.stringify(result, null, 2));
    const root = stringFlag(parsed, "output");
    if (root) {
      await writeText(ensureChild(root, "docs/submission/venue_template_profile.json"), JSON.stringify(result.profile, null, 2) + "\n");
      await writeText(ensureChild(root, "docs/submission/template_decision.md"), templateDecisionMarkdown(result, input));
    }
    return 0;
  }
  throw new Error(`unknown templates action: ${action}`);
}

async function commandPaper(argv: string[]): Promise<number> {
  const action = argv[0] ?? "render";
  const parsed = parseArgs(argv.slice(1));
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  if (action === "render") {
    const profileInput = templateInputFromFlags(parsed);
    const resolved = await resolveTemplateProfile(profileInput);
    const manifest = await readManifestIfExists(root);
    const title = stringFlag(parsed, "title") ?? titleFromProjectName(manifest?.project_name ?? "Evidence-First Research Draft");
    const mode = stringFlag(parsed, "mode") ?? stringFlag(parsed, "review-mode") ?? resolved.profile.default_review_mode;
    const reviewMode = normalizeReviewMode(mode, resolved.profile.default_review_mode);
    const rendered = renderPaper({
      profile: resolved.profile,
      projectName: manifest?.project_name ?? "idea2repo-project",
      title,
      anonymous: reviewMode === "anonymous",
      reviewMode,
      bibFile: "references.bib",
      macrosFile: "macros.tex"
    });
    for (const [relativePath, content] of Object.entries(rendered.files)) await writeText(ensureChild(root, relativePath), content);
    await writeSubmissionTemplateArtifacts(root, resolved.profile, profileInput, resolved.verificationTasks, rendered.warnings);
    console.log(`Paper rendered with ${resolved.profile.profile_id}: ${ensureChild(root, "paper/main.tex")}`);
    if (rendered.warnings.length) console.log(`Warnings: ${rendered.warnings.length}`);
    return 0;
  }
  if (action === "check") {
    const profile = await profileFromRenderedOrFlags(root, parsed);
    const explicitMode = stringFlag(parsed, "mode") ?? stringFlag(parsed, "review-mode");
    const reviewMode = explicitMode ? normalizeReviewMode(explicitMode, profile.default_review_mode) : (await renderedReviewMode(root)) ?? normalizeReviewMode(profile.default_review_mode, profile.default_review_mode);
    const compliance = await checkTemplateCompliance(root, {
      profile,
      anonymous: reviewMode === "anonymous",
      strict: hasFlag(parsed, "strict")
    });
    await writeText(ensureChild(root, "docs/submission/template_compliance_report.md"), complianceMarkdown(compliance));
    await writeText(ensureChild(root, "docs/submission/anonymity_check.md"), anonymityMarkdown(compliance));
    if (hasFlag(parsed, "compile")) {
      const compile = await compilePaper(root, profile);
      await writeText(ensureChild(root, "docs/submission/compile_result.json"), JSON.stringify(compile, null, 2) + "\n");
    }
    console.log(`Template compliance: ${compliance.status}`);
    console.log(`Report written: ${ensureChild(root, "docs/submission/template_compliance_report.md")}`);
    return compliance.status === "failed" ? 1 : 0;
  }
  if (action === "package") {
    const result = await packagePaper(root, { forOverleaf: hasFlag(parsed, "for-overleaf") });
    await writeText(ensureChild(root, "docs/submission/submission_package.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(`Submission packages: ${result.files.map((file) => file.path).join(", ")}`);
    if (result.warnings.length) console.log(`Warnings: ${result.warnings.length}`);
    return 0;
  }
  throw new Error(`unknown paper action: ${action}`);
}

async function commandGenerate(argv: string[], researchMode = false): Promise<number> {
  const parsed = parseArgs(argv);
  const idea = parsed._.join(" ").trim();
  if (!idea) throw new Error("idea must not be empty");
  const weeks = numberFlag(parsed, "weeks", 12);
  const offline = hasFlag(parsed, "offline");
  const provider = stringFlag(parsed, "provider") ?? (offline ? "offline" : null);
  const result = await generateResearchRepo(idea, stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project", {
    requestedDomains: valuesFlag(parsed, "domain"),
    timelineWeeks: weeks,
    resources: valuesFlag(parsed, "resource"),
    force: hasFlag(parsed, "force"),
    stack: stringFlag(parsed, "stack") === "ts" ? "ts" : "python",
    offline,
    provider,
    model: stringFlag(parsed, "model"),
    reasoningEffort: stringFlag(parsed, "reasoning"),
    runResearchPipeline: researchMode || hasFlag(parsed, "run-research-pipeline"),
    allowNetwork: hasFlag(parsed, "allow-network"),
    downloadPdfs: hasFlag(parsed, "download-pdfs"),
    allowPdfDownload: hasFlag(parsed, "allow-network") && hasFlag(parsed, "download-pdfs"),
    maxPapers: numberFlag(parsed, "max-papers", 20),
    sources: valuesFlag(parsed, "source"),
    strictCcfA: hasFlag(parsed, "strict-ccf-a"),
    venue: stringFlag(parsed, "venue") ?? undefined,
    template: stringFlag(parsed, "template") ?? undefined,
    reviewMode: generateReviewModeFlag(stringFlag(parsed, "review-mode") ?? stringFlag(parsed, "mode")),
    paperType: generatePaperTypeFlag(stringFlag(parsed, "paper-type")),
    templateYear: optionalNumberFlag(parsed, "template-year") ?? optionalNumberFlag(parsed, "year"),
    compilePaper: hasFlag(parsed, "compile-paper"),
    packageOverleaf: hasFlag(parsed, "package-overleaf"),
    jsonlEvents: hasFlag(parsed, "jsonl-events"),
    permissionPolicy: policyFromFlags(parsed)
  });
  const diagnosis = result.diagnosis;
  console.log(`Generated Idea2Repo project: ${result.root}`);
  console.log(`Primary route: ${diagnosis.routes[0]?.domain.label ?? "unknown"}`);
  console.log(`Raw Idea Score: ${diagnosis.raw_score.total} / 100`);
  console.log(`Revised Plan Score: ${diagnosis.revised_score.total} / 100`);
  console.log(`Provider: ${result.provider_id}`);
  console.log(`Analysis source: ${result.analysis_source}`);
  if (result.research_pipeline) console.log(`Research pipeline stages: ${result.research_pipeline.state.stages.length}`);
  if (result.template_profile_id) console.log(`Template profile: ${result.template_profile_id}`);
  if (result.fallback_reason) console.log(`Fallback reason: ${result.fallback_reason}`);
  console.log("Main report: reports/ccf_a_readiness_report.md");
  console.log("Execution plan: plans/12_week_execution_plan.md");
  return 0;
}

async function commandLiterature(argv: string[]): Promise<number> {
  const action = argv[0] ?? "search";
  const parsed = parseArgs(argv.slice(1));
  const root = stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project";
  if (action === "plan") {
    const idea = await ideaFromArgsOrManifest(parsed, root);
    const pipeline = await runResearchPipeline(idea, {
      requestedDomains: valuesFlag(parsed, "domain"),
      timelineWeeks: numberFlag(parsed, "weeks", 12),
      resources: valuesFlag(parsed, "resource"),
      maxPapers: numberFlag(parsed, "max-papers", 20),
      provider: "offline",
      strictCcfA: hasFlag(parsed, "strict-ccf-a")
    });
    await writeText(ensureChild(root, "docs/relative_work/search_plan.json"), JSON.stringify(pipeline.searchPlan, null, 2) + "\n");
    await writeText(ensureChild(root, "docs/idea/idea_brief.md"), pipeline.artifacts["docs/idea/idea_brief.md"] ?? `# Idea Brief\n\n${idea}\n`);
    console.log(`Literature search plan written: ${ensureChild(root, "docs/relative_work/search_plan.json")}`);
    console.log(`Precision queries: ${pipeline.searchPlan.precision_queries.length}`);
    console.log(`Recall queries: ${pipeline.searchPlan.recall_queries.length}`);
    return 0;
  }
  if (action === "search") {
    const queries = await queriesFromArgsOrPlan(parsed, root);
    const result = await searchLiteratureAsync({
      queries,
      allowNetwork: hasFlag(parsed, "allow-network"),
      limit: numberFlag(parsed, "max-papers", numberFlag(parsed, "limit", 20)),
      sources: normalizeSources(valuesFlag(parsed, "source") as LiteratureSource[])
    });
    await writeText(ensureChild(root, "docs/relative_work/candidates.json"), JSON.stringify(result.candidates, null, 2) + "\n");
    await writeText(ensureChild(root, "docs/relative_work/search_report.md"), result.search_report);
    console.log(`Literature candidates written: ${ensureChild(root, "docs/relative_work/candidates.json")}`);
    console.log(`Candidates: ${result.candidates.length}`);
    if (result.warnings.length) console.log(`Warnings: ${result.warnings.length}`);
    return 0;
  }
  if (action === "download") {
    const candidatesPath = ensureChild(root, "docs/relative_work/candidates.json");
    if (!(await exists(candidatesPath))) throw new Error(`missing literature candidates: ${candidatesPath}`);
    const candidates = JSON.parse(await readFile(candidatesPath, "utf8")) as never[];
    const manifest = await acquirePdfs(candidates, {
      outputRoot: root,
      allowNetwork: hasFlag(parsed, "allow-network"),
      downloadPdfs: hasFlag(parsed, "download-pdfs")
    });
    await writeText(ensureChild(root, "docs/reference/pdf_manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const chunks = await buildPdfChunkIndex(root, manifest);
    await writeText(ensureChild(root, "docs/reference/pdf_chunks.json"), JSON.stringify(chunks, null, 2) + "\n");
    console.log(`PDF manifest written: ${ensureChild(root, "docs/reference/pdf_manifest.json")}`);
    console.log(`PDF chunk index written: ${ensureChild(root, "docs/reference/pdf_chunks.json")}`);
    console.log(`Downloaded PDFs: ${manifest.filter((record) => record.status === "downloaded").length}`);
    console.log(`Unavailable PDFs: ${manifest.filter((record) => record.status !== "downloaded").length}`);
    return 0;
  }
  throw new Error(`unknown literature action: ${action}`);
}

async function commandStatus(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const current = await projectStatus(stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project");
  console.log(`Project: ${current.project_name}`);
  console.log(`Stage: ${current.stage}`);
  console.log(`Artifacts: ${current.present_artifacts}/${current.total_artifacts} present`);
  console.log(`Missing: ${current.missing_artifacts.length}`);
  console.log(`Modified: ${current.modified_artifacts.length}`);
  return 0;
}

async function commandResume(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const result = await resumeResearchRepo(stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project", {
    force: hasFlag(parsed, "force"),
    permissionPolicy: policyFromFlags(parsed)
  });
  console.log(`Resumed Idea2Repo project: ${result.root}`);
  console.log(`Restored files: ${result.files.length}`);
  return 0;
}

async function commandValidate(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const errors = await validateProject(stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project");
  if (errors.length) {
    for (const error of errors) console.error(error);
    return 1;
  }
  console.log("Validation passed");
  return 0;
}

async function commandDoctor(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const snapshot = inspectWorkspace(stringFlag(parsed, "cwd") ?? ".");
  const oauth = await openaiCodexOAuthProvider.status();
  console.log(`cwd: ${snapshot.cwd}`);
  console.log(`git_root: ${snapshot.git_root ?? "not detected"}`);
  console.log(`git_branch: ${snapshot.git_branch ?? "not detected"}`);
  console.log(`git_status_entries: ${snapshot.git_status_short.length}`);
  console.log(`oauth_login: ${oauth.loggedIn ? "logged in" : "not logged in"}`);
  console.log(`oauth_endpoint: ${oauth.endpoint}`);
  return 0;
}

async function commandAuth(argv: string[]): Promise<number> {
  const action = argv[0] ?? "status";
  const parsed = parseArgs(argv.slice(1));
  if (action === "status") {
    const status = await openaiCodexOAuthProvider.status();
    console.log(`Auth: ${status.statusText}`);
    console.log(`Endpoint: ${status.endpoint}`);
    const credentials = await new AuthStorage().get("openai-codex");
    if (credentials) {
      console.log(`Account: ${credentials.accountId}`);
      console.log("Access token: stored");
      console.log("Refresh token: stored");
      console.log(`Expires: ${new Date(credentials.expires).toISOString()}`);
    }
    return 0;
  }
  if (action === "limits") {
    const usage = await openaiCodexOAuthProvider.usage();
    console.log(`Source: ${usage.source}`);
    if (usage.limitName) console.log(`Limit: ${usage.limitName}`);
    if (usage.primary) console.log(`Primary: ${JSON.stringify(usage.primary)}`);
    if (usage.secondary) console.log(`Secondary: ${JSON.stringify(usage.secondary)}`);
    if (usage.credits) console.log(`Credits: ${JSON.stringify(usage.credits)}`);
    return 0;
  }
  if (action === "logout") {
    await openaiCodexOAuthProvider.logout();
    console.log("Logged out");
    return 0;
  }
  if (action === "login") {
    const rl = createInterface({ input, output });
    try {
      const credentials = await openaiCodexOAuthProvider.login({
        openBrowser: !hasFlag(parsed, "no-browser"),
        onAuth: (pending) => {
          console.log("Open this URL to sign in with OpenAI:");
          console.log(pending.url);
          console.log("Waiting for the browser callback, or paste the redirect URL when prompted.");
        },
        onManualCodeInput: async () => rl.question("Paste redirect URL or authorization code if browser callback does not complete: "),
        onPrompt: async (prompt) => rl.question(`${prompt.message} `)
      });
      await new AuthStorage().set("openai-codex", credentials);
      console.log("Logged in via Idea2Repo OpenAI Codex OAuth");
      return 0;
    } finally {
      rl.close();
    }
  }
  throw new Error(`unknown auth action: ${action}`);
}

async function commandProvider(argv: string[]): Promise<number> {
  const action = argv[0] ?? "list";
  if (action === "list") {
    console.log("openai-codex (default, Codex OAuth)");
    console.log("openai-codex-oauth (legacy alias for openai-codex)");
    console.log("openai-codex-cli (official CLI wrapper, codex exec structured output)");
    console.log("offline (deterministic fallback)");
    const catalog = loadCodexModelCatalog();
    console.log(`models: ${catalog.models.map((model) => model.id).join(", ")} (${catalog.source})`);
    return 0;
  }
  if (action === "show") {
    const id = canonicalProvider(argv[1]);
    console.log(safeProviderReport(id));
    const adapter = createProviderAdapter(id);
    console.log(JSON.stringify(await adapter.status(), null, 2));
    return 0;
  }
  if (action === "validate") {
    console.log(JSON.stringify(providerSchema(), null, 2));
    return 0;
  }
  throw new Error(`unknown provider action: ${action}`);
}

function commandVenues(argv: string[]): number {
  const action = argv[0] ?? "validate";
  const parsed = parseArgs(argv.slice(1));
  if (action !== "validate") throw new Error(`unknown venues action: ${action}`);
  const database = loadVenueDatabase(stringFlag(parsed, "path") ?? undefined);
  const errors = validateVenueDatabase(database);
  if (errors.length) {
    for (const error of errors) console.error(error);
    return 1;
  }
  const total = Object.values(database.domains).reduce((sum, domain) => sum + Object.keys(domain.venue_records).length, 0);
  console.log(`Venue database valid: ${database.version} (${total} records)`);
  return 0;
}

async function commandGithub(argv: string[]): Promise<number> {
  const action = argv[0] ?? "dry-run";
  const parsed = parseArgs(argv.slice(1));
  const plan = await buildGithubExportPlan(stringFlag(parsed, "output") ?? "generated_repos/idea2repo-project", {
    repoName: stringFlag(parsed, "repo-name") ?? "",
    createIssues: !hasFlag(parsed, "no-issues")
  });
  if (action === "dry-run") {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  if (action === "publish") {
    const result = await publishWithGh(plan, { permissionPolicy: policyFromFlags(parsed) });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  throw new Error(`unknown github action: ${action}`);
}

async function commandApi(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const port = numberFlag(parsed, "port", 8000);
  const host = stringFlag(parsed, "host") ?? "127.0.0.1";
  const server = await startApiServer({ host, port });
  console.log(`Idea2Repo API listening on ${server.url}`);
  await waitForTermination();
  await server.close();
  return 0;
}

async function commandWeb(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const apiPort = numberFlag(parsed, "api-port", 8000);
  const api = await startApiServer({ port: apiPort });
  console.log(`Idea2Repo API listening on ${api.url}`);
  console.log("Starting web dashboard with npm --workspace web run dev");
  const child = spawn("npm", ["--workspace", "web", "run", "dev", "--", "--host", "127.0.0.1"], {
    stdio: "inherit",
    env: proxyEnvForChild({ ...process.env, VITE_API_BASE_URL: api.url })
  });
  const code = await new Promise<number>((resolve) => child.on("exit", (exitCode) => resolve(exitCode ?? 0)));
  await api.close();
  return code;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [], flags: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    const name = rawName!;
    let value = inlineValue;
    if (value == null && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      value = argv[index + 1]!;
      index += 1;
    }
    const values = parsed.flags.get(name) ?? [];
    values.push(value ?? "true");
    parsed.flags.set(name, values);
  }
  return parsed;
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name) && parsed.flags.get(name)?.at(-1) !== "false";
}

function stringFlag(parsed: ParsedArgs, name: string): string | null {
  const value = parsed.flags.get(name)?.at(-1);
  return value && value !== "true" ? value : null;
}

function valuesFlag(parsed: ParsedArgs, name: string): string[] {
  return (parsed.flags.get(name) ?? []).filter((value) => value !== "true" && value.trim());
}

function numberFlag(parsed: ParsedArgs, name: string, fallback: number): number {
  const raw = stringFlag(parsed, name);
  const value = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function optionalNumberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const raw = stringFlag(parsed, name);
  if (raw == null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function generateReviewModeFlag(value: string | null): GenerateOptions["reviewMode"] {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace("_", "-");
  if (normalized === "camera-ready" || normalized === "camera") return "camera-ready";
  if (normalized === "non-anonymous" || normalized === "nonanonymous") return "non-anonymous";
  if (normalized === "review" || normalized === "anonymous") return "anonymous";
  return undefined;
}

function generatePaperTypeFlag(value: string | null): GenerateOptions["paperType"] {
  if (value === "full" || value === "short" || value === "demo" || value === "dataset" || value === "system" || value === "benchmark") return value;
  return undefined;
}

function normalizeTemplateMode(mode: string | null): "review" | "camera_ready" | undefined {
  if (!mode) return undefined;
  const normalized = mode.toLowerCase().replace("-", "_");
  if (normalized === "camera_ready") return "camera_ready";
  if (normalized === "review" || normalized === "anonymous" || normalized === "non_anonymous") return "review";
  return undefined;
}

async function ideaFromArgsOrManifest(parsed: ParsedArgs, root: string): Promise<string> {
  const idea = parsed._.join(" ").trim() || stringFlag(parsed, "idea");
  if (idea) return idea;
  try {
    return (await readManifest(root)).request.idea;
  } catch {
    return "local research idea";
  }
}

async function queriesFromArgsOrPlan(parsed: ParsedArgs, root: string): Promise<string[]> {
  const direct = [...valuesFlag(parsed, "query"), parsed._.join(" ").trim()].filter(Boolean);
  if (direct.length) return direct;
  const planPath = ensureChild(root, "docs/relative_work/search_plan.json");
  if (await exists(planPath)) {
    const plan = JSON.parse(await readFile(planPath, "utf8")) as {
      precision_queries?: Array<{ query?: string }>;
      recall_queries?: Array<{ query?: string }>;
      baseline_queries?: Array<{ query?: string }>;
      dataset_metric_queries?: Array<{ query?: string }>;
      venue_queries?: Array<{ query?: string }>;
      collision_queries?: Array<{ query?: string }>;
    };
    const queries = [
      ...(plan.precision_queries ?? []),
      ...(plan.recall_queries ?? []),
      ...(plan.baseline_queries ?? []),
      ...(plan.dataset_metric_queries ?? []),
      ...(plan.venue_queries ?? []),
      ...(plan.collision_queries ?? [])
    ].map((entry) => entry.query?.trim() ?? "").filter(Boolean);
    if (queries.length) return queries;
  }
  return ["research agent benchmark baseline dataset metric"];
}

async function trustedPdfChunksFromProject(root: string): Promise<{ manifest: PdfManifestRecord[]; chunks: PdfChunkIndexEntry[]; warnings: string[] }> {
  const manifest = await readJsonFile<PdfManifestRecord[]>(root, "docs/reference/pdf_manifest.json", []);
  const storedChunks = await readJsonFile<PdfChunkIndexEntry[]>(root, "docs/reference/pdf_chunks.json", []);
  const trusted = await rebuildTrustedPdfChunks(root, manifest, storedChunks);
  const trustedPaperIds = new Set(trusted.chunks.map((chunk) => chunk.paper_id));
  const safeManifest = manifest.filter((record) => record.status !== "downloaded" || trustedPaperIds.has(record.paper_id));
  return { manifest: safeManifest, chunks: trusted.chunks, warnings: trusted.warnings };
}

async function readJsonFile<T>(root: string, relativePath: string, fallback: T): Promise<T> {
  const path = ensureChild(root, relativePath);
  if (!(await exists(path))) return fallback;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readManifestIfExists(root: string): Promise<Awaited<ReturnType<typeof readManifest>> | null> {
  try {
    return await readManifest(root);
  } catch {
    return null;
  }
}

function templateInputFromFlags(parsed: ParsedArgs): TemplateResolveInput {
  return {
    venue: stringFlag(parsed, "venue") ?? (parsed._.join(" ").trim() || undefined),
    domain: stringFlag(parsed, "domain") ?? undefined,
    family: stringFlag(parsed, "family") ?? stringFlag(parsed, "template") ?? undefined,
    year: optionalNumberFlag(parsed, "year") ?? optionalNumberFlag(parsed, "template-year"),
    mode: normalizeTemplateMode(stringFlag(parsed, "mode") ?? stringFlag(parsed, "review-mode")),
    paperType: stringFlag(parsed, "paper-type") ?? undefined
  };
}

async function profileFromRenderedOrFlags(root: string, parsed: ParsedArgs): Promise<VenueTemplateProfile> {
  const profilePath = ensureChild(root, "paper/template/profile.json");
  if (await exists(profilePath)) return JSON.parse(await readFile(profilePath, "utf8")) as VenueTemplateProfile;
  return (await resolveTemplateProfile(templateInputFromFlags(parsed))).profile;
}

async function renderedReviewMode(root: string): Promise<ReviewMode | null> {
  const configPath = ensureChild(root, "paper/template/render_config.json");
  if (!(await exists(configPath))) return null;
  const config = JSON.parse(await readFile(configPath, "utf8")) as { review_mode?: string };
  return normalizeReviewMode(config.review_mode ?? null, "anonymous");
}

async function writeSubmissionTemplateArtifacts(root: string, profile: VenueTemplateProfile, input: TemplateResolveInput, verificationTasks: string[], warnings: string[]): Promise<void> {
  const resolved = await resolveTemplateProfile(input);
  await writeText(ensureChild(root, "docs/submission/target_venue.md"), `# Target Venue\n\n${input.venue ?? profile.venue_name}\n`);
  await writeText(ensureChild(root, "docs/submission/venue_template_profile.json"), JSON.stringify(profile, null, 2) + "\n");
  await writeText(ensureChild(root, "docs/submission/template_decision.md"), templateDecisionMarkdown({ ...resolved, profile, verificationTasks }, input));
  await writeText(ensureChild(root, "docs/submission/submission_checklist.md"), submissionChecklistMarkdown(profile, verificationTasks, warnings));
  await writeText(ensureChild(root, "docs/submission/camera_ready_todo.md"), cameraReadyTodoMarkdown(profile));
}

function submissionChecklistMarkdown(profile: VenueTemplateProfile, verificationTasks: string[], warnings: string[]): string {
  return `# Submission Checklist

- [x] Template profile selected: ${profile.profile_id}
- [ ] Official CFP and style files verified for target year
- [ ] Anonymous mode checked
- [ ] Compliance check passed
- [ ] Page limits, checklist, appendix, and supplement rules confirmed

## Verification Tasks

${verificationTasks.length ? verificationTasks.map((task) => `- ${task}`).join("\n") : "- None"}

## Render Warnings

${warnings.length ? warnings.map((warning) => `- ${warning}`).join("\n") : "- None"}
`;
}

function cameraReadyTodoMarkdown(profile: VenueTemplateProfile): string {
  return `# Camera Ready TODO

- Re-enable author and affiliation blocks only after acceptance.
- Replace anonymous links with final artifact URLs when venue policy allows.
- Confirm ${profile.venue_name} camera-ready page limits and rights blocks.
- Re-run paper check and package commands before upload.
`;
}

function titleFromProjectName(projectName: string): string {
  return projectName
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Evidence-First Research Draft";
}

function normalizeReviewMode(mode: string | null | undefined, fallback: ReviewMode): ReviewMode {
  if (!mode) return fallback;
  const normalized = mode.toLowerCase().replace("-", "_");
  if (normalized === "camera_ready" || normalized === "camera") return "camera_ready";
  if (normalized === "non_anonymous" || normalized === "nonanonymous" || normalized === "non_anonymized") return "non_anonymous";
  if (normalized === "review" || normalized === "anonymous") return "anonymous";
  return fallback;
}

function verifiedEvidencePaperCount(rows: ReturnType<typeof extractEvidenceRows>): number {
  return new Set(rows.filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id).map((row) => row.paper_id)).size;
}

function evidenceBackedCandidates(candidates: PaperCandidate[], rows: ReturnType<typeof extractEvidenceRows>, chunks: PdfChunkIndexEntry[]): PaperCandidate[] {
  const backedPaperIds = new Set(
    trustedEvidenceRows(rows, chunks)
      .filter((row) => row.status === "verified" && row.page && row.quote && row.chunk_id)
      .map((row) => row.paper_id)
  );
  return candidates.filter((candidate) => backedPaperIds.has(safePaperId(candidate.candidate_id)));
}

function safePaperId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "paper";
}

function policyFromFlags(parsed: ParsedArgs): PermissionPolicy {
  return {
    allowWrite: true,
    allowOverwrite: hasFlag(parsed, "force"),
    allowNetwork: hasFlag(parsed, "allow-network"),
    allowLogin: hasFlag(parsed, "allow-login"),
    allowInstall: hasFlag(parsed, "allow-install"),
    allowPublish: hasFlag(parsed, "allow-publish")
  };
}

function printHelp(): void {
  console.log(`Idea2Repo

Usage:
  idea2repo "research idea" [--output dir] [--offline] [--stack python|ts]
  idea2repo research "research idea" [options]
  idea2repo generate "research idea" [options]  # legacy alias
  idea2repo plan --output generated_repos/demo
  idea2repo trace --output generated_repos/demo
  idea2repo stage retry|skip <stage_id> --output generated_repos/demo [--reason text]
  idea2repo snapshots list --output generated_repos/demo
  idea2repo restore --snapshot <id> --output generated_repos/demo
  idea2repo restore --artifact <path> --output generated_repos/demo
  idea2repo literature plan|search|download [--output dir] [--allow-network]
  idea2repo papers analyze [--output dir]
  idea2repo score [--output dir] [--strict-ccf-a]
  idea2repo refine [--output dir]
  idea2repo templates list|show|validate
  idea2repo paper render|check|package [--output dir] [--venue value]
  idea2repo status|resume|validate [--output dir]
  idea2repo auth status|login|logout
  idea2repo provider list|show|validate
  idea2repo venues validate
  idea2repo github dry-run|publish
  idea2repo api [--host 127.0.0.1] [--port 8000]
  idea2repo web

Options:
  --domain value       Domain or venue hint; repeatable
  --weeks 8|12|16|24  Execution timeline
  --resource value     Resource constraint; repeatable
  --force              Allow overwrite of non-empty output
  --offline            Use deterministic local fallback
  --provider id        openai-codex, openai-codex-oauth, openai-codex-cli, offline
  --model id           Codex model id
  --reasoning effort   Codex reasoning effort
  --max-papers n       Literature search result cap
  --query value        Literature query; repeatable
  --source value       Literature source; repeatable
  --download-pdfs      Download public PDF URLs during literature download
  --run-research-pipeline
                       Use evidence-first pipeline during generate
  --venue value        Target venue for template packaging
  --review-mode value  anonymous, non-anonymous, or camera-ready
  --compile-paper      Try latexmk/tectonic after rendering paper
  --package-overleaf   Create paper/submission/overleaf.zip
`);
}

async function waitForTermination(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().then((code) => {
    process.exitCode = code;
  });
}
