import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const cwd = resolve(".");
const cli = join(cwd, "dist/cli.js");

test("built CLI and npm pack dry-run are usable", async () => {
  const help = await execFileAsync(process.execPath, [cli, "--help"], { cwd });
  assert.match(help.stdout, /Idea2Repo/);

  const root = await mkdtemp(join(tmpdir(), "idea2repo pack path "));
  const output = join(root, "windows style path case");
  try {
    await execFileAsync(process.execPath, [
      cli,
      "generate",
      "A TS research scaffold with baselines, datasets, metrics, ablations, and recent literature.",
      "--output",
      output,
      "--offline",
      "--stack",
      "ts"
    ]);
    const status = await execFileAsync(process.execPath, [cli, "status", "--output", output]);
    assert.match(status.stdout, /Artifacts:/);
    const validate = await execFileAsync(process.execPath, [cli, "validate", "--output", output]);
    assert.match(validate.stdout, /Validation passed/);
    const resume = await execFileAsync(process.execPath, [cli, "resume", "--output", output]);
    assert.match(resume.stdout, /Resumed Idea2Repo project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const packed = await execNpm(["pack", "--dry-run", "--json"]);
  const entries = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = new Set(entries[0]?.files.map((file) => file.path) ?? []);
  assert.equal(paths.has("package.json"), true);
  assert.equal(paths.has("dist/cli.js"), true);
  assert.equal(paths.has("data/venues.json"), true);
});

async function execNpm(args: string[]) {
  if (process.env.npm_execpath) return execFileAsync(process.execPath, [process.env.npm_execpath, ...args], { cwd });
  return execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, shell: process.platform === "win32" });
}
