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
    confidence: ConfidenceSchema
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
    claimEvidenceRows: Type.Array(Type.Record(Type.String(), Type.String())),
    warnings: Type.Array(Type.String())
  },
  { additionalProperties: true }
);

export type IdeaBrief = Static<typeof IdeaBriefSchema>;
export type SearchPlan = Static<typeof SearchPlanSchema>;
export type SearchQueryPlan = Static<typeof SearchQueryPlanSchema>;
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
export type PdfPaperNote = Static<typeof PdfPaperNoteSchema>;
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
