import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { PaperPackageResult } from "./types.js";

export type ZipEntry = {
  path: string;
  data: Buffer | string;
};

export async function packagePaper(root: string, options: { forOverleaf?: boolean } = {}): Promise<PaperPackageResult> {
  const warnings: string[] = [];
  const outputs: Array<{ path: string; bytes: number }> = [];
  if (options.forOverleaf) {
    const entries = await collectEntries(join(root, "paper"), "", (path) => !path.startsWith("submission/") && !path.startsWith("build/"));
    if (!entries.length) warnings.push("paper directory is empty; overleaf package has no paper files");
    const path = join(root, "paper/submission/overleaf.zip");
    await writeZip(path, entries);
    outputs.push({ path: "paper/submission/overleaf.zip", bytes: (await stat(path)).size });
  }
  const submissionEntries = [
    ...(await collectEntries(join(root, "paper"), "paper", (path) => !path.startsWith("submission/"))),
    ...(await collectEntries(join(root, "docs/submission"), "docs/submission"))
  ];
  const submissionPath = join(root, "paper/submission/submission.zip");
  await writeZip(submissionPath, submissionEntries);
  outputs.push({ path: "paper/submission/submission.zip", bytes: (await stat(submissionPath)).size });
  return { files: outputs, warnings };
}

async function collectEntries(root: string, prefix: string, include: (path: string) => boolean = () => true): Promise<ZipEntry[]> {
  try {
    if (!(await stat(root)).isDirectory()) return [];
  } catch {
    return [];
  }
  const entries: ZipEntry[] = [];
  await collect(root, root, prefix, include, entries);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function collect(current: string, root: string, prefix: string, include: (path: string) => boolean, entries: ZipEntry[]): Promise<void> {
  for (const dirent of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, dirent.name);
    if (dirent.isDirectory()) {
      await collect(absolute, root, prefix, include, entries);
      continue;
    }
    if (!dirent.isFile()) continue;
    const rel = toPosix(relative(root, absolute));
    if (!include(rel)) continue;
    entries.push({ path: prefix ? `${prefix}/${rel}` : rel, data: await readFile(absolute) });
  }
}

async function writeZip(path: string, entries: ZipEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, createZipArchive(entries));
}

export function createZipArchive(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(0, 10);
    centralEntry.writeUInt16LE(0, 12);
    centralEntry.writeUInt16LE(0, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(data.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(name.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, name);
    offset += local.length + name.length + data.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function toPosix(value: string): string {
  return value.split("\\").join("/");
}
