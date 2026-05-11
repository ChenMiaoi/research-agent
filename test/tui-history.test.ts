import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addHistoryEntry, isHistorySafe, readTuiInputHistory, writeTuiInputHistory } from "../src/tui/history.js";

test("TUI input history deduplicates normal entries and rejects sensitive OAuth values", () => {
  let history = addHistoryEntry([], "build a research repo");
  history = addHistoryEntry(history, "/model");
  history = addHistoryEntry(history, "build a research repo");
  history = addHistoryEntry(history, "http://127.0.0.1:1455/auth/callback?code=secret");
  assert.deepEqual(history, ["/model", "build a research repo"]);
  assert.equal(isHistorySafe("authorization code: abc"), false);
  assert.equal(isHistorySafe("plain research idea"), true);
});

test("TUI input history persists with restricted file permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "idea2repo-tui-history-"));
  const path = join(root, "history", "input-history.json");
  try {
    await writeTuiInputHistory(["/generate", "Bearer secret-token", "novel systems benchmark"], path);
    assert.deepEqual(await readTuiInputHistory(path), ["/generate", "novel systems benchmark"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), ["/generate", "novel systems benchmark"]);
    if (platform() !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
