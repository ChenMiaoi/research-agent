import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TemplateComplianceCheck, TemplateComplianceResult, VenueTemplateProfile } from "./types.js";

export async function checkTemplateCompliance(
  root: string,
  options: { profile: VenueTemplateProfile; anonymous?: boolean; strict?: boolean }
): Promise<TemplateComplianceResult> {
  const checks: TemplateComplianceCheck[] = [];
  const profile = options.profile;
  await requireFile(root, "paper/main.tex", checks);
  await requireFile(root, "paper/references.bib", checks);
  for (const file of profile.required_files) await requireFile(root, file, checks);
  if (profile.paper_rules.checklist_required) await requireFile(root, "paper/checklist/reproducibility_checklist.tex", checks, "required checklist is missing");

  const main = await readTextIfExists(join(root, "paper/main.tex"));
  const allPaperText = await collectPaperText(root);
  checkBibliographyStyle(main, profile, checks);
  const anonymous = Boolean(options.anonymous ?? profile.paper_rules.anonymity_required);
  checkAnonymous(allPaperText, anonymous, checks);
  checkForbiddenPatterns(allPaperText, profile, checks, anonymous);
  await checkSectionStructure(root, checks);

  const errors = checks.filter((check) => check.status === "failed").map((check) => check.message);
  const warnings = checks.filter((check) => check.status === "warning").map((check) => check.message);
  if (options.strict && warnings.length) errors.push(...warnings);
  return {
    status: errors.length ? "failed" : "passed",
    checks,
    errors,
    warnings
  };
}

export function checkTemplateComplianceArtifacts(
  files: Record<string, string>,
  options: { profile: VenueTemplateProfile; anonymous?: boolean; strict?: boolean }
): TemplateComplianceResult {
  const checks: TemplateComplianceCheck[] = [];
  const profile = options.profile;
  requireFileInArtifacts(files, "paper/main.tex", checks);
  requireFileInArtifacts(files, "paper/references.bib", checks);
  for (const file of profile.required_files) requireFileInArtifacts(files, file, checks);
  if (profile.paper_rules.checklist_required) requireFileInArtifacts(files, "paper/checklist/reproducibility_checklist.tex", checks, "required checklist is missing");

  const main = files["paper/main.tex"] ?? "";
  const allPaperText = collectPaperTextFromArtifacts(files);
  checkBibliographyStyle(main, profile, checks);
  const anonymous = Boolean(options.anonymous ?? profile.paper_rules.anonymity_required);
  checkAnonymous(allPaperText, anonymous, checks);
  checkForbiddenPatterns(allPaperText, profile, checks, anonymous);
  checkSectionStructureArtifacts(files, checks);

  const errors = checks.filter((check) => check.status === "failed").map((check) => check.message);
  const warnings = checks.filter((check) => check.status === "warning").map((check) => check.message);
  if (options.strict && warnings.length) errors.push(...warnings);
  return {
    status: errors.length ? "failed" : "passed",
    checks,
    errors,
    warnings
  };
}

export function complianceMarkdown(result: TemplateComplianceResult): string {
  return `# Template Compliance Report

- Status: ${result.status}
- Errors: ${result.errors.length}
- Warnings: ${result.warnings.length}

## Checks

${result.checks.map((check) => `- ${check.status.toUpperCase()}: ${check.id} — ${check.message}`).join("\n")}
`;
}

export function anonymityMarkdown(result: TemplateComplianceResult): string {
  const anonymityChecks = result.checks.filter((check) => check.id.startsWith("anonymous"));
  return `# Anonymity Check

- Status: ${anonymityChecks.some((check) => check.status === "failed") ? "failed" : "passed"}

${anonymityChecks.length ? anonymityChecks.map((check) => `- ${check.status.toUpperCase()}: ${check.message}`).join("\n") : "- No anonymity checks were required."}
`;
}

async function requireFile(root: string, relativePath: string, checks: TemplateComplianceCheck[], failureMessage?: string): Promise<void> {
  const exists = await fileExists(join(root, relativePath));
  checks.push({
    id: `file:${relativePath}`,
    status: exists ? "passed" : "failed",
    message: exists ? `${relativePath} exists` : (failureMessage ?? `${relativePath} is missing`)
  });
}

function requireFileInArtifacts(files: Record<string, string>, relativePath: string, checks: TemplateComplianceCheck[], failureMessage?: string): void {
  const exists = Object.hasOwn(files, relativePath);
  checks.push({
    id: `file:${relativePath}`,
    status: exists ? "passed" : "failed",
    message: exists ? `${relativePath} exists` : (failureMessage ?? `${relativePath} is missing`)
  });
}

function checkBibliographyStyle(main: string, profile: VenueTemplateProfile, checks: TemplateComplianceCheck[]): void {
  const expected = profile.latex.bibliography_style;
  if (!expected) return;
  const passed = main.includes(`\\bibliographystyle{${expected}}`);
  checks.push({
    id: "bibliography-style",
    status: passed ? "passed" : "failed",
    message: passed ? `bibliography style is ${expected}` : `expected \\bibliographystyle{${expected}}`
  });
  checks.push({
    id: "references-path",
    status: main.includes("\\bibliography{references}") ? "passed" : "failed",
    message: main.includes("\\bibliography{references}") ? "references.bib path is correct" : "expected \\bibliography{references}"
  });
}

function checkAnonymous(text: string, anonymous: boolean, checks: TemplateComplianceCheck[]): void {
  if (!anonymous) return;
  const leaks = [/\\author\{[^}\s][^}]*\}/i, /\\affiliation\{/i, /\\institute\{/i, /\\institution\{/i, /github\.com\/[^\s}]+/i, /anonymous\s+authors?\s+omitted/i];
  const failed = leaks.some((pattern) => pattern.test(text));
  checks.push({
    id: "anonymous-no-author-affiliation",
    status: failed ? "failed" : "passed",
    message: failed ? "anonymous mode contains author, affiliation, institution, or GitHub leakage" : "anonymous mode has no author, affiliation, institution, or GitHub leakage"
  });
}

function checkForbiddenPatterns(text: string, profile: VenueTemplateProfile, checks: TemplateComplianceCheck[], anonymous: boolean): void {
  if (!anonymous) return;
  for (const pattern of profile.forbidden_patterns ?? []) {
    const regexp = new RegExp(pattern, "i");
    const failed = regexp.test(text);
    checks.push({
      id: `forbidden:${pattern}`,
      status: failed ? "failed" : "passed",
      message: failed ? `forbidden pattern matched: ${pattern}` : `forbidden pattern absent: ${pattern}`
    });
  }
}

async function checkSectionStructure(root: string, checks: TemplateComplianceCheck[]): Promise<void> {
  const required = [
    "paper/sections/00_abstract.tex",
    "paper/sections/01_introduction.tex",
    "paper/sections/02_related_work.tex",
    "paper/sections/03_method.tex",
    "paper/sections/04_experiments.tex",
    "paper/sections/08_conclusion.tex"
  ];
  for (const file of required) {
    const exists = await fileExists(join(root, file));
    checks.push({
      id: `section:${file}`,
      status: exists ? "passed" : "warning",
      message: exists ? `${file} exists` : `${file} missing from expected section structure`
    });
  }
}

function checkSectionStructureArtifacts(files: Record<string, string>, checks: TemplateComplianceCheck[]): void {
  const required = [
    "paper/sections/00_abstract.tex",
    "paper/sections/01_introduction.tex",
    "paper/sections/02_related_work.tex",
    "paper/sections/03_method.tex",
    "paper/sections/04_experiments.tex",
    "paper/sections/08_conclusion.tex"
  ];
  for (const file of required) {
    const exists = Object.hasOwn(files, file);
    checks.push({
      id: `section:${file}`,
      status: exists ? "passed" : "warning",
      message: exists ? `${file} exists` : `${file} missing from expected section structure`
    });
  }
}

async function collectPaperText(root: string): Promise<string> {
  const paths = [
    "paper/main.tex",
    "paper/macros.tex",
    "paper/sections/00_abstract.tex",
    "paper/sections/01_introduction.tex",
    "paper/sections/02_related_work.tex",
    "paper/sections/03_method.tex",
    "paper/sections/04_experiments.tex",
    "paper/sections/05_results.tex",
    "paper/sections/06_discussion.tex",
    "paper/sections/07_limitations.tex",
    "paper/sections/08_conclusion.tex",
    "paper/appendix/appendix.tex",
    "paper/checklist/reproducibility_checklist.tex"
  ];
  const parts = await Promise.all(paths.map((path) => readTextIfExists(join(root, path))));
  return parts.join("\n");
}

function collectPaperTextFromArtifacts(files: Record<string, string>): string {
  const paths = [
    "paper/main.tex",
    "paper/macros.tex",
    "paper/sections/00_abstract.tex",
    "paper/sections/01_introduction.tex",
    "paper/sections/02_related_work.tex",
    "paper/sections/03_method.tex",
    "paper/sections/04_experiments.tex",
    "paper/sections/05_results.tex",
    "paper/sections/06_discussion.tex",
    "paper/sections/07_limitations.tex",
    "paper/sections/08_conclusion.tex",
    "paper/appendix/appendix.tex",
    "paper/checklist/reproducibility_checklist.tex"
  ];
  return paths.map((path) => files[path] ?? "").join("\n");
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
