import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_CLI_PROVIDER_ID } from "../src/providers.js";
import { CodexCliAdapter, extractStructuredJson, type CodexCliRunner } from "../src/providers/index.js";
import { researchAnalysisJsonSchema, validateResearchAnalysis } from "../src/types.js";

const validAnalysis = {
  schema_version: 1,
  idea_summary: "Codex CLI adapter",
  problem_statement: "Need structured CLI output.",
  domain_route: { key: "ai_llm_agent", label: "AI / LLM Agent", rationale: "Agent runtime provider." },
  raw_score: { total: 40, rationale: "early" },
  revised_score: { total: 55, rationale: "clearer" },
  feasibility: "feasible",
  revised_plan: { summary: "adapter", feasibility: "feasible" },
  experiment_plan: {},
  reviewer_simulation: "Reviewer asks for schema tests."
};

test("Codex CLI adapter reports availability through codex --version", async () => {
  const commands: string[][] = [];
  const runner: CodexCliRunner = async (_command, args) => {
    commands.push(args);
    return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
  };
  const adapter = new CodexCliAdapter({ runner, cwd: "D:/repo" });

  assert.equal(await adapter.available(), true);
  const status = await adapter.status();
  assert.equal(status.id, CODEX_CLI_PROVIDER_ID);
  assert.equal(status.available, true);
  assert.deepEqual(commands, [["--version"], ["--version"]]);
});

test("Codex CLI adapter invokes codex exec with structured output schema and validates JSON", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner: CodexCliRunner = async (_command, args, options) => {
    calls.push({ args, input: options.input });
    return { stdout: JSON.stringify(validAnalysis), stderr: "", code: 0 };
  };
  const adapter = new CodexCliAdapter({ runner, cwd: "D:/repo", sandbox: "read-only" });
  const analysis = await adapter.structured({
    task: "Analyze idea",
    schemaName: "ResearchAnalysis",
    context: { idea: "Codex CLI adapter" },
    outputSchema: researchAnalysisJsonSchema(),
    validate: validateResearchAnalysis
  });

  assert.equal(analysis.idea_summary, "Codex CLI adapter");
  assert.deepEqual(calls[0]?.args.slice(0, 3), ["exec", "--json", "--output-schema"]);
  assert.match(calls[0]?.args[3] ?? "", /idea_summary/);
  assert.ok(calls[0]?.args.includes("--sandbox"));
  assert.match(calls[0]?.input ?? "", /JSON Schema/);
});

test("Codex CLI adapter rejects invalid JSON before fallback can hide schema errors", async () => {
  const adapter = new CodexCliAdapter({
    cwd: "D:/repo",
    runner: async () => ({ stdout: "not json", stderr: "", code: 0 })
  });
  await assert.rejects(
    adapter.structured({
      task: "Analyze idea",
      schemaName: "ResearchAnalysis",
      context: { idea: "bad json" },
      outputSchema: researchAnalysisJsonSchema(),
      validate: validateResearchAnalysis
    }),
    /valid JSON/
  );
});

test("Codex CLI adapter requires a real output schema", async () => {
  const adapter = new CodexCliAdapter({
    cwd: "D:/repo",
    runner: async () => ({ stdout: JSON.stringify(validAnalysis), stderr: "", code: 0 })
  });
  await assert.rejects(
    adapter.structured({
      task: "Analyze idea",
      schemaName: "ResearchAnalysis",
      context: { idea: "missing schema" },
      validate: validateResearchAnalysis
    }),
    /requires outputSchema/
  );
});

test("extractStructuredJson unwraps codex output_text payloads and JSONL final events", () => {
  assert.deepEqual(extractStructuredJson(JSON.stringify({ output_text: JSON.stringify(validAnalysis) })), validAnalysis);
  assert.deepEqual(extractStructuredJson(`{"type":"progress"}\n${JSON.stringify({ final: validAnalysis })}\n`), validAnalysis);
  assert.deepEqual(extractStructuredJson(`{"type":"progress"}\n${JSON.stringify({ result: JSON.stringify(validAnalysis) })}\n`), validAnalysis);
});
