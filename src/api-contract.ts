export type GenerateRequest = {
  idea: string;
  output: string;
  domains?: string[];
  weeks?: number;
  resources?: string[];
  stack?: "python" | "ts";
  force?: boolean;
  offline?: boolean;
  provider?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  run_research_pipeline?: boolean;
  allow_network?: boolean;
  download_pdfs?: boolean;
  max_papers?: number;
  sources?: string[];
  strict_ccf_a?: boolean;
  venue?: string;
  template?: string;
  review_mode?: "anonymous" | "camera-ready" | "non-anonymous";
  paper_type?: "full" | "short" | "demo" | "dataset" | "system" | "benchmark";
  template_year?: number;
  compile_paper?: boolean;
  package_overleaf?: boolean;
};

export type GenerateResponse = {
  root: string;
  project_name: string;
  primary_route: string | undefined;
  raw_score: number;
  revised_score: number;
  evidence_gate: Record<string, unknown>;
  security: Record<string, unknown>;
  analysis_source: string;
  codex_available: boolean;
  codex_logged_in: boolean;
  codex_model: string | null;
  fallback_reason: string;
  research_pipeline_stages?: number;
  template_profile_id?: string | null;
};

export type PathRequest = {
  output: string;
};

export type StatusResponse = {
  project_name: string;
  stage: string;
  total_artifacts: number;
  present_artifacts: number;
  missing_artifacts: string[];
  modified_artifacts: string[];
};

export type ArtifactReadRequest = {
  output: string;
  path: string;
};

export type ArtifactReadResponse = {
  path: string;
  bytes: number;
  content: string;
};

export type GithubDryRunRequest = {
  output: string;
  repo_name?: string;
  create_issues?: boolean;
};
