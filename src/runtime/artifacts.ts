import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { artifactRecord, ensureChild, exists, MANIFEST_PATH, now, readManifest } from "../state.js";
import type { ProjectManifest } from "../types.js";
import { runtimeTimestamp, type EventSink } from "./events.js";

export const ARTIFACT_SNAPSHOTS_DIR = join(".idea2repo", "snapshots", "artifacts");
export const ARTIFACT_SNAPSHOT_INDEX = join(ARTIFACT_SNAPSHOTS_DIR, "index.jsonl");

export type ArtifactSnapshotRecord = {
  id: string;
  run_id?: string;
  path: string;
  snapshot_path: string;
  bytes: number;
  sha256: string;
  created_at: string;
};

export async function snapshotArtifact(
  root: string,
  relativePath: string,
  options: { runId?: string; events?: EventSink; timestamp?: string } = {}
): Promise<ArtifactSnapshotRecord | null> {
  const artifactPath = ensureChild(root, relativePath);
  if (!(await exists(artifactPath))) return null;
  const content = await readFile(artifactPath);
  const createdAt = options.timestamp ?? runtimeTimestamp();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const snapshotRelativePath = join(ARTIFACT_SNAPSHOTS_DIR, id, toPosix(relativePath));
  const snapshotPath = ensureChild(root, snapshotRelativePath);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, content);
  const record: ArtifactSnapshotRecord = {
    id,
    ...(options.runId ? { run_id: options.runId } : {}),
    path: toPosix(relativePath),
    snapshot_path: toPosix(snapshotRelativePath),
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    created_at: createdAt
  };
  await mkdir(dirname(ensureChild(root, ARTIFACT_SNAPSHOT_INDEX)), { recursive: true });
  await appendFile(ensureChild(root, ARTIFACT_SNAPSHOT_INDEX), `${JSON.stringify(record)}\n`, "utf8");
  await options.events?.emit({
    type: "artifact.snapshot",
    run_id: options.runId ?? "manual",
    snapshot_id: record.id,
    path: record.path,
    timestamp: createdAt
  });
  return record;
}

export async function listArtifactSnapshots(root: string): Promise<ArtifactSnapshotRecord[]> {
  const indexPath = ensureChild(root, ARTIFACT_SNAPSHOT_INDEX);
  if (!(await exists(indexPath))) return [];
  const raw = await readFile(indexPath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArtifactSnapshotRecord)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.path.localeCompare(right.path));
}

export async function restoreArtifactSnapshot(
  root: string,
  options: { snapshotId?: string; artifactPath?: string; runId?: string; events?: EventSink } = {}
): Promise<ArtifactSnapshotRecord> {
  const snapshots = await listArtifactSnapshots(root);
  const record = options.snapshotId
    ? snapshots.find((snapshot) => snapshot.id === options.snapshotId)
    : [...snapshots].reverse().find((snapshot) => snapshot.path === toPosix(options.artifactPath ?? ""));
  if (!record) throw new Error(options.snapshotId ? `snapshot not found: ${options.snapshotId}` : `snapshot not found for artifact: ${options.artifactPath ?? ""}`);
  const snapshotPath = ensureChild(root, record.snapshot_path);
  const artifactPath = ensureChild(root, record.path);
  const content = await readFile(snapshotPath);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, content);
  await refreshManifestArtifactHashes(root, [record.path]);
  await options.events?.emit({
    type: "artifact.restored",
    run_id: options.runId ?? record.run_id ?? "manual",
    snapshot_id: record.id,
    path: record.path,
    timestamp: runtimeTimestamp()
  });
  return record;
}

export async function refreshManifestArtifactHashes(root: string, relativePaths?: string[]): Promise<ProjectManifest | null> {
  const manifestPath = ensureChild(root, MANIFEST_PATH);
  if (!(await exists(manifestPath))) return null;
  const manifest = await readManifest(root);
  const requested = relativePaths ? new Set(relativePaths.map(toPosix).filter((path) => !path.startsWith(".idea2repo/"))) : null;
  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  const paths = requested ? [...requested] : [...artifacts.keys()];
  for (const path of paths) {
    const absolute = ensureChild(root, path);
    if (await exists(absolute)) artifacts.set(path, await artifactRecord(root, absolute));
    else artifacts.delete(path);
  }
  const updated: ProjectManifest = {
    ...manifest,
    updated_at: now(),
    artifacts: [...artifacts.values()].sort((left, right) => left.path.localeCompare(right.path))
  };
  await writeFile(manifestPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return updated;
}

export function formatSnapshots(records: ArtifactSnapshotRecord[]): string {
  if (!records.length) return "No artifact snapshots recorded.";
  return records.map((record) => `${record.id}\t${record.path}\t${record.bytes} bytes\t${record.created_at}`).join("\n");
}

function toPosix(value: string): string {
  return value.split("\\").join("/");
}
