import { spawn } from "node:child_process";
import { CODEX_CLI_PROVIDER_ID, apiShapeForProvider } from "../providers.js";
import { proxyEnvForChild } from "../proxy.js";
import type { ProviderAdapter, StructuredRequest } from "./adapter.js";

export type CodexCliRunResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type CodexCliRunner = (command: string, args: string[], options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv }) => Promise<CodexCliRunResult>;

export class CodexCliAdapter implements ProviderAdapter {
  readonly id = CODEX_CLI_PROVIDER_ID;

  constructor(
    private readonly options: {
      runner?: CodexCliRunner;
      cwd?: string;
      sandbox?: "read-only" | "workspace-write";
      command?: string;
    } = {}
  ) {}

  async available(): Promise<boolean> {
    const result = await this.run(["--version"], { cwd: this.cwd() }).catch(() => null);
    return Boolean(result && result.code === 0);
  }

  async status(): Promise<Record<string, unknown>> {
    const version = await this.run(["--version"], { cwd: this.cwd() }).catch((error: unknown) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: 127
    }));
    return {
      id: this.id,
      available: version.code === 0,
      version: version.stdout.trim() || version.stderr.trim() || null,
      api_shape: apiShapeForProvider(this.id),
      capabilities: ["codex_exec_json", "structured_output"],
      auth_boundary: "Uses the official Codex CLI process; Idea2Repo does not read ~/.codex auth files or browser cookies.",
      sandbox: this.options.sandbox ?? "read-only"
    };
  }

  async structured<T>(request: StructuredRequest<T>): Promise<T> {
    if (!request.outputSchema) throw new Error(`Codex CLI structured request requires outputSchema for ${request.schemaName}`);
    const outputSchema = JSON.stringify(request.outputSchema);
    const prompt = codexExecPrompt(request);
    const args = [
      "exec",
      "--json",
      "--output-schema",
      outputSchema,
      "--cd",
      this.cwd(),
      "--sandbox",
      this.options.sandbox ?? "read-only",
      "-"
    ];
    const result = await this.run(args, { cwd: this.cwd(), input: prompt });
    if (result.code !== 0) {
      throw new Error(`codex exec failed with code ${result.code}: ${trim(result.stderr || result.stdout)}`);
    }
    request.progress?.("Codex CLI: received structured output");
    return request.validate(extractStructuredJson(result.stdout));
  }

  private cwd(): string {
    return this.options.cwd ?? process.cwd();
  }

  private async run(args: string[], options: { cwd: string; input?: string }): Promise<CodexCliRunResult> {
    if (this.options.runner) return this.options.runner(this.options.command ?? "codex", args, { cwd: options.cwd, input: options.input, env: proxyEnvForChild() });
    return spawnCodex(this.options.command ?? "codex", args, { cwd: options.cwd, input: options.input, env: proxyEnvForChild() });
  }
}

async function spawnCodex(command: string, args: string[], options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv }): Promise<CodexCliRunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 0
      });
    });
    child.stdin.end(options.input ?? "");
  });
}

export function extractStructuredJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("codex exec produced no output");
  const direct = tryJson(trimmed);
  if (direct !== null) return unwrapCodexJson(direct);
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsedLines = lines.map((line) => tryJson(line)).filter((line) => line !== null);
  for (const parsed of parsedLines.slice().reverse()) {
    if (isStructuredJsonCarrier(parsed)) return unwrapCodexJson(parsed);
  }
  for (const parsed of parsedLines.slice().reverse()) {
    const unwrapped = unwrapCodexJson(parsed);
    if (unwrapped !== parsed || (unwrapped && typeof unwrapped === "object" && !hasEventOnlyShape(unwrapped))) return unwrapped;
  }
  const block = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (block) {
    const parsed = tryJson(block.trim());
    if (parsed !== null) return unwrapCodexJson(parsed);
  }
  throw new Error("codex exec output did not contain valid JSON");
}

function unwrapCodexJson(value: unknown): unknown {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.output_text === "string") return extractStructuredJson(record.output_text);
    if (typeof record.final === "string") return extractStructuredJson(record.final);
    if (record.final && typeof record.final === "object") return record.final;
    if (typeof record.result === "string") return extractStructuredJson(record.result);
    if (record.result && typeof record.result === "object") return record.result;
  }
  return value;
}

function isStructuredJsonCarrier(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.output_text === "string" || record.final != null || record.result != null;
}

function hasEventOnlyShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && (keys[0] === "type" || keys[0] === "event");
}

function tryJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function codexExecPrompt<T>(request: StructuredRequest<T>): string {
  return [
    request.task,
    "",
    "Return only JSON that validates against the requested schema.",
    `Schema name: ${request.schemaName}`,
    request.outputSchema ? `JSON Schema:\n${JSON.stringify(request.outputSchema, null, 2)}` : "",
    request.promptFile ? `Prompt file hint: ${request.promptFile}` : "",
    "Context:",
    JSON.stringify(request.context, null, 2)
  ].filter(Boolean).join("\n");
}

function trim(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
