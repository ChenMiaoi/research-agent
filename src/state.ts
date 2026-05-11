import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ProjectManifest } from "./types.js";

export const STATE_DIR = ".idea2repo";
export const MANIFEST_PATH = join(STATE_DIR, "manifest.json");
export const RUN_LOG_PATH = join(STATE_DIR, "run_log.jsonl");

export type ProjectStatus = {
  root: string;
  project_name: string;
  stage: string;
  total_artifacts: number;
  present_artifacts: number;
  missing_artifacts: string[];
  modified_artifacts: string[];
};

export async function artifactRecord(root: string, path: string): Promise<{ path: string; sha256: string; bytes: number }> {
  const content = await readFile(path);
  return {
    path: toPosix(relative(root, path)),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength
  };
}

export async function writeManifest(
  root: string,
  options: {
    projectName: string;
    idea: string;
    requestedDomains?: string[];
    timelineWeeks: number;
    resources: string[];
    stack: "python" | "ts";
    createdAt: string;
    files: string[];
    permissions: Record<string, boolean>;
    workspace: Record<string, unknown>;
    generation?: Record<string, unknown>;
  }
): Promise<string> {
  const stateDir = join(root, STATE_DIR);
  await mkdir(stateDir, { recursive: true });
  const artifacts = [];
  for (const file of [...options.files].sort()) {
    if (await exists(file)) {
      const rel = toPosix(relative(root, file));
      if (!rel.startsWith(`${STATE_DIR}/`)) artifacts.push(await artifactRecord(root, file));
    }
  }
  const manifest: ProjectManifest = {
    version: 1,
    project_name: options.projectName,
    stage: "idea_diagnosis",
    created_at: options.createdAt,
    updated_at: now(),
    request: {
      idea: options.idea,
      requested_domains: options.requestedDomains ?? [],
      timeline_weeks: options.timelineWeeks,
      resources: options.resources,
      stack: options.stack
    },
    permissions: options.permissions,
    workspace: options.workspace,
    generation: options.generation ?? {},
    artifacts
  };
  const path = join(root, MANIFEST_PATH);
  await writeText(path, JSON.stringify(manifest, null, 2) + "\n");
  await appendRunLog(root, "manifest_written", { artifacts: artifacts.length });
  return path;
}

export async function appendRunLog(root: string, event: string, data: Record<string, unknown> = {}): Promise<void> {
  const path = join(root, RUN_LOG_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ timestamp: now(), event, data }) + "\n", { encoding: "utf8", flag: "a" });
}

export async function readManifest(root: string): Promise<ProjectManifest> {
  const path = join(root, MANIFEST_PATH);
  if (!(await exists(path))) throw new Error(`missing Idea2Repo manifest: ${path}`);
  return JSON.parse(await readFile(path, "utf8")) as ProjectManifest;
}

export async function status(root: string): Promise<ProjectStatus> {
  const projectRoot = resolve(root);
  const manifest = await readManifest(projectRoot);
  const missing: string[] = [];
  const modified: string[] = [];
  for (const artifact of manifest.artifacts) {
    const path = join(projectRoot, artifact.path);
    if (!(await exists(path))) {
      missing.push(artifact.path);
      continue;
    }
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (digest !== artifact.sha256) modified.push(artifact.path);
  }
  return {
    root: projectRoot,
    project_name: manifest.project_name,
    stage: manifest.stage,
    total_artifacts: manifest.artifacts.length,
    present_artifacts: manifest.artifacts.length - missing.length,
    missing_artifacts: missing,
    modified_artifacts: modified
  };
}

export async function validate(root: string): Promise<string[]> {
  const current = await status(root);
  return [
    ...current.missing_artifacts.map((path) => `missing artifact: ${path}`),
    ...current.modified_artifacts.map((path) => `modified artifact: ${path}`)
  ];
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8" });
}

export async function writeBinary(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function ensureChild(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const rel = relative(resolvedRoot, resolvedChild);
  if (rel.startsWith("..") || rel === "" || resolve(rel) === rel) {
    throw new Error(`path escapes output root: ${child}`);
  }
  return resolvedChild;
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}
