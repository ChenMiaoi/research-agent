import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";

export const ConfidenceSchema = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);

export const IdeaBriefSchema = Type.Object(
  {
    idea_summary: Type.String(),
    problem: Type.String(),
    target_domain: Type.String(),
    target_venues: Type.Array(Type.String()),
    method_keywords: Type.Array(Type.String()),
    task_keywords: Type.Array(Type.String()),
    evaluation_keywords: Type.Array(Type.String()),
    resource_constraints: Type.Array(Type.String()),
    missing_information: Type.Array(Type.String()),
    assumptions: Type.Array(Type.String()),
    search_seed_terms: Type.Array(Type.String())
  },
  { additionalProperties: false }
);

export const SearchQueryPlanSchema = Type.Object(
  {
    query: Type.String(),
    source_hints: Type.Array(Type.String()),
    purpose: Type.String()
  },
  { additionalProperties: false }
);

export const SearchPlanSchema = Type.Object(
  {
    core_concepts: Type.Array(Type.String()),
    synonyms: Type.Array(Type.String()),
    precision_queries: Type.Array(SearchQueryPlanSchema),
    recall_queries: Type.Array(SearchQueryPlanSchema),
    baseline_queries: Type.Array(SearchQueryPlanSchema),
    dataset_metric_queries: Type.Array(SearchQueryPlanSchema),
    venue_queries: Type.Array(SearchQueryPlanSchema),
    collision_queries: Type.Array(SearchQueryPlanSchema),
    stop_condition: Type.String()
  },
  { additionalProperties: false }
);

export const EvidenceRefSchema = Type.Object(
  {
    page: Type.Integer({ minimum: 1 }),
    quote: Type.String(),
    chunk_id: Type.String(),
    purpose: Type.String()
  },
  { additionalProperties: false }
);

export const PdfPaperNoteSchema = Type.Object(
  {
    paper_id: Type.String(),
    title_verified: Type.Boolean(),
    summary: Type.String(),
    main_problem: Type.String(),
    core_method: Type.String(),
    main_claims: Type.Array(
      Type.Object(
        {
          claim: Type.String(),
          evidence_quote: Type.String(),
          page: Type.Integer({ minimum: 1 }),
          chunk_id: Type.String(),
          confidence: ConfidenceSchema
        },
        { additionalProperties: false }
      )
    ),
    datasets: Type.Array(Type.String()),
    baselines: Type.Array(Type.String()),
    metrics: Type.Array(Type.String()),
    strengths: Type.Array(Type.String()),
    weaknesses: Type.Array(Type.String()),
    limitations: Type.Array(Type.String()),
    relevance_to_current_idea: Type.String(),
    difference_from_current_idea: Type.String(),
    collision_risk: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    useful_for: Type.Array(Type.String()),
    unreadable_or_missing_parts: Type.Array(Type.String())
  },
  { additionalProperties: false }
);

export const CandidateTriageSchema = Type.Object(
  {
    must_read_core_papers: Type.Array(Type.String()),
    expanded_papers: Type.Array(Type.String()),
    baselines: Type.Array(Type.String()),
    datasets: Type.Array(Type.String()),
    surveys: Type.Array(Type.String()),
    weakly_related: Type.Array(Type.String()),
    duplicates: Type.Array(Type.String()),
    missing_search_areas: Type.Array(Type.String()),
    rationale: Type.String()
  },
  { additionalProperties: false }
);

export const RelatedWorkAnalysisSchema = Type.Object(
  {
    topic_clusters: Type.Array(Type.Record(Type.String(), Type.String())),
    related_work_matrix_rows: Type.Array(Type.Record(Type.String(), Type.String())),
    reviewer_expected_baselines: Type.Array(Type.String()),
    evaluation_conventions: Type.Array(Type.String()),
    evidence_warnings: Type.Array(Type.String())
  },
  { additionalProperties: false }
);

export const NoveltyGapAnalysisSchema = Type.Object(
  {
    collision_risk: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    collision_reasons: Type.Array(Type.String()),
    novelty_gaps: Type.Array(Type.String()),
    defensible_gap: Type.String(),
    evidence_warnings: Type.Array(Type.String())
  },
  { additionalProperties: false }
);

const StrictCcfADimensionsSchema = Type.Object(
  {
    problem_significance: Type.Number({ minimum: 0, maximum: 10 }),
    novelty: Type.Number({ minimum: 0, maximum: 20 }),
    technical_depth: Type.Number({ minimum: 0, maximum: 15 }),
    method_clarity: Type.Number({ minimum: 0, maximum: 10 }),
    experimental_rigor: Type.Number({ minimum: 0, maximum: 20 }),
    related_work: Type.Number({ minimum: 0, maximum: 10 }),
    feasibility_reproducibility: Type.Number({ minimum: 0, maximum: 10 }),
    venue_story: Type.Number({ minimum: 0, maximum: 5 })
  },
  { additionalProperties: false }
);

export const StrictCcfAReviewSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0, maximum: 100 }),
    dimensions: StrictCcfADimensionsSchema,
    cap_reasons: Type.Array(Type.String()),
    evidence_warnings: Type.Array(Type.String()),
    recommendations: Type.Array(Type.String())
  },
  { additionalProperties: false }
);

export const ReviewerReportSchema = Type.Object(
  {
    reviewer_id: Type.Union([Type.Literal("R1"), Type.Literal("R2"), Type.Literal("R3")]),
    role: Type.Union([Type.Literal("Novelty / Related Work"), Type.Literal("Method / Experiment"), Type.Literal("Venue / Story")]),
    verdict: Type.Union([Type.Literal("Weak reject"), Type.Literal("Borderline"), Type.Literal("Weak accept")]),
    summary: Type.String(),
    major_concerns: Type.Array(Type.String()),
    minor_concerns: Type.Array(Type.String()),
    required_evidence: Type.Array(Type.String()),
    questions_to_authors: Type.Array(Type.String()),
    what_would_change_my_score: Type.Array(Type.String())
  },
  { additionalProperties: false }
);

export const FeasibilityReviewSchema = Type.Object(
  {
    timeline_weeks: Type.Integer({ minimum: 1 }),
    feasible_mvp: Type.Array(Type.String()),
    ambitious_extensions: Type.Array(Type.String()),
    risks: Type.Array(Type.String()),
    unavailable_resource_warnings: Type.Array(Type.String()),
    verdict: Type.String()
  },
  { additionalProperties: false }
);

export const ResearchStrategySchema = Type.Object(
  {
    revised_idea: Type.String(),
    central_hypothesis: Type.String(),
    baselines: Type.Array(Type.String()),
    datasets: Type.Array(Type.String()),
    metrics: Type.Array(Type.String()),
    ablations: Type.Array(Type.String()),
    failure_cases: Type.Array(Type.String()),
    first_4_week_plan: Type.Array(Type.String()),
    paper_story: Type.String()
  },
  { additionalProperties: false }
);

export const PaperCandidateSchema = Type.Object(
  {
    candidate_id: Type.String(),
    title: Type.String(),
    authors: Type.Array(Type.String()),
    year: Type.Union([Type.Integer(), Type.Null()]),
    venue: Type.Optional(Type.String()),
    doi: Type.Optional(Type.String()),
    arxiv_id: Type.Optional(Type.String()),
    openalex_id: Type.Optional(Type.String()),
    dblp_key: Type.Optional(Type.String()),
    semantic_scholar_id: Type.Optional(Type.String()),
    source_urls: Type.Array(Type.String()),
    pdf_urls: Type.Array(Type.String()),
    abstract: Type.Optional(Type.String()),
    retrieval_sources: Type.Array(Type.String()),
    retrieval_queries: Type.Array(Type.String()),
    confidence: ConfidenceSchema,
    ccf_rank: Type.Optional(Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C"), Type.Literal("unknown")])),
    venue_match: Type.Optional(Type.Union([Type.Literal("target"), Type.Literal("primary"), Type.Literal("secondary"), Type.Literal("ccf_a"), Type.Literal("known"), Type.Literal("unknown")])),
    track_status: Type.Optional(Type.Union([Type.Literal("main_conference"), Type.Literal("journal"), Type.Literal("workshop"), Type.Literal("demo"), Type.Literal("short_paper"), Type.Literal("unknown")])),
    novelty_risk: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"), Type.Literal("unknown")])),
    reason: Type.Optional(Type.String()),
    main_track_eligible: Type.Optional(Type.Boolean()),
    inclusion_reason: Type.Optional(Type.String()),
    exclusion_reason: Type.Optional(Type.String()),
    ccf_gate_status: Type.Optional(Type.Union([Type.Literal("included"), Type.Literal("excluded")])),
    source_provenance: Type.Optional(Type.Array(Type.String())),
    pdf_status: Type.Optional(Type.Union([Type.Literal("available"), Type.Literal("unavailable"), Type.Literal("needs_approval"), Type.Literal("downloaded")]))
  },
  { additionalProperties: false }
);

export const ResearchPipelineResultSchema = Type.Object(
  {
    state: Type.Record(Type.String(), Type.Unknown()),
    ideaBrief: IdeaBriefSchema,
    searchPlan: SearchPlanSchema,
    verifiedPapers: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    artifacts: Type.Record(Type.String(), Type.String()),
    baselineRecommendations: Type.Array(Type.String()),
    datasetRecommendations: Type.Array(Type.String()),
    metricRecommendations: Type.Array(Type.String()),
    claimEvidenceRows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    warnings: Type.Array(Type.String())
  },
  { additionalProperties: true }
);

export type IdeaBrief = Static<typeof IdeaBriefSchema>;
export type SearchPlan = Static<typeof SearchPlanSchema>;
export type SearchQueryPlan = Static<typeof SearchQueryPlanSchema>;
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
export type PdfPaperNote = Static<typeof PdfPaperNoteSchema>;
export type CandidateTriage = Static<typeof CandidateTriageSchema>;
export type RelatedWorkAnalysis = Static<typeof RelatedWorkAnalysisSchema>;
export type NoveltyGapAnalysis = Static<typeof NoveltyGapAnalysisSchema>;
export type StrictCcfAReview = Static<typeof StrictCcfAReviewSchema>;
export type ReviewerReport = Static<typeof ReviewerReportSchema>;
export type FeasibilityReview = Static<typeof FeasibilityReviewSchema>;
export type ResearchStrategy = Static<typeof ResearchStrategySchema>;
export type PaperCandidate = Static<typeof PaperCandidateSchema>;
export type ResearchPipelineSchemaResult = Static<typeof ResearchPipelineResultSchema>;

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

export function validateWithSchema<T>(schema: object, value: unknown, label: string): T {
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${label} did not match schema: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  return value as T;
}

export function validateIdeaBrief(value: unknown): IdeaBrief {
  return validateWithSchema<IdeaBrief>(IdeaBriefSchema, value, "IdeaBrief");
}

export function validateSearchPlan(value: unknown): SearchPlan {
  return validateWithSchema<SearchPlan>(SearchPlanSchema, value, "SearchPlan");
}

export function validatePdfPaperNote(value: unknown): PdfPaperNote {
  return validateWithSchema<PdfPaperNote>(PdfPaperNoteSchema, value, "PdfPaperNote");
}

export function validateCandidateTriage(value: unknown): CandidateTriage {
  return validateWithSchema<CandidateTriage>(CandidateTriageSchema, value, "CandidateTriage");
}

export function validateRelatedWorkAnalysis(value: unknown): RelatedWorkAnalysis {
  return validateWithSchema<RelatedWorkAnalysis>(RelatedWorkAnalysisSchema, value, "RelatedWorkAnalysis");
}

export function validateNoveltyGapAnalysis(value: unknown): NoveltyGapAnalysis {
  return validateWithSchema<NoveltyGapAnalysis>(NoveltyGapAnalysisSchema, value, "NoveltyGapAnalysis");
}

export function validateStrictCcfAReview(value: unknown): StrictCcfAReview {
  return validateWithSchema<StrictCcfAReview>(StrictCcfAReviewSchema, value, "StrictCcfAReview");
}

export function validateReviewerReport(value: unknown): ReviewerReport {
  return validateWithSchema<ReviewerReport>(ReviewerReportSchema, value, "ReviewerReport");
}

export function validateFeasibilityReview(value: unknown): FeasibilityReview {
  return validateWithSchema<FeasibilityReview>(FeasibilityReviewSchema, value, "FeasibilityReview");
}

export function validateResearchStrategy(value: unknown): ResearchStrategy {
  return validateWithSchema<ResearchStrategy>(ResearchStrategySchema, value, "ResearchStrategy");
}
