import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeTimestamp } from "./events.js";

export const RUN_CONTEXT_PATH = join(".idea2repo", "run_context.json");

export type RuntimeRunContext = {
  version: 1;
  run_id: string;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  sources: string[];
  venue: string | null;
  allow_network: boolean;
  download_pdfs: boolean;
  max_papers: number;
  approval_policy: {
    allow_write: boolean;
    allow_overwrite: boolean;
    allow_network: boolean;
    allow_pdf_download?: boolean;
    allow_publish: boolean;
    allow_shell: boolean;
  };
  requested_domains: string[];
  timeline_weeks: number;
  resources: string[];
  stack: "python" | "ts";
  updated_at: string;
};

export async function writeRuntimeRunContext(root: string, context: Omit<RuntimeRunContext, "version" | "updated_at">): Promise<string> {
  const path = join(root, RUN_CONTEXT_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, ...context, updated_at: runtimeTimestamp() }, null, 2) + "\n", "utf8");
  return path;
}

export async function readRuntimeRunContext(root: string): Promise<RuntimeRunContext | null> {
  try {
    return JSON.parse(await readFile(join(root, RUN_CONTEXT_PATH), "utf8")) as RuntimeRunContext;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
