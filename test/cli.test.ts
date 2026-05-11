import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";

test("CLI supports legacy idea invocation and project commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-cli-"));
  const output = join(root, "project");
  try {
    assert.equal(
      await main([
        "A local-first LLM agent benchmark with baseline, dataset, metric, ablation, and recent 2026 literature.",
        "--output",
        output,
        "--offline",
        "--stack",
        "ts"
      ]),
      0
    );
    assert.equal(await main(["status", "--output", output]), 0);
    assert.equal(await main(["literature", "plan", "Agent benchmark with baselines", "--output", output]), 0);
    assert.equal(await main(["literature", "search", "--output", output, "--query", "agent benchmark"]), 0);
    assert.equal(await main(["literature", "download", "--output", output]), 0);
    assert.equal(await main(["validate", "--output", output]), 0);
    assert.equal(await main(["papers", "analyze", "--output", output]), 0);
    assert.equal(await main(["score", "--output", output, "--strict-ccf-a"]), 0);
    assert.equal(await main(["refine", "--output", output]), 0);
    assert.equal(await main(["github", "dry-run", "--output", output]), 0);
    assert.equal(await main(["provider", "list"]), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
