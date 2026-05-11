import assert from "node:assert/strict";
import { test } from "node:test";
import { completeSlashInput, getSlashHint, getSlashSuggestions, resolveSlashCommandInput, selectedSlashSuggestion } from "../src/tui/slash-commands.js";

test("slash command suggestions match command prefixes", () => {
  const suggestions = getSlashSuggestions("/pro");
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.name),
    ["/provider"]
  );
  assert.equal(suggestions[0]?.usage, "/provider");
});

test("slash command completion handles command names", () => {
  assert.equal(completeSlashInput("/stat"), "/status");
  assert.equal(completeSlashInput("/trac"), "/trace");
  assert.equal(completeSlashInput("/deci"), "/decisions");
  assert.equal(completeSlashInput("/artifa"), "/artifact");
  assert.equal(completeSlashInput("/prov"), "/provider");
  assert.equal(completeSlashInput("/provider o"), "/provider o");
  assert.equal(completeSlashInput("/github d"), "/github d");
});

test("slash command suggestions include runtime commands", () => {
  assert.deepEqual(
    getSlashSuggestions("/art").map((suggestion) => suggestion.name),
    ["/artifacts", "/artifact"]
  );
  assert.deepEqual(
    getSlashSuggestions("/dec").map((suggestion) => suggestion.name),
    ["/decisions"]
  );
});

test("slash command selection resolves partial commands", () => {
  assert.equal(selectedSlashSuggestion("/mo", 0)?.completion, "/model");
  assert.equal(selectedSlashSuggestion("/res", 0)?.completion, "/research");
  assert.equal(resolveSlashCommandInput("/mo", 0), "/model");
  assert.equal(resolveSlashCommandInput("/res", 0), "/research");
  assert.equal(resolveSlashCommandInput("/model", 0), "/model");
  assert.equal(resolveSlashCommandInput("/provider offline", 0), "/provider offline");
  assert.equal(resolveSlashCommandInput("/lim", 0), "/limits");
  assert.equal(resolveSlashCommandInput("/limit", 0), "/limit");
  assert.equal(resolveSlashCommandInput("/retry", 0), "/retry");
  assert.equal(resolveSlashCommandInput("/mode g", 0), "/mode g");
  assert.equal(resolveSlashCommandInput("/app", 0), "/approvals");
  assert.equal(resolveSlashCommandInput("/approv", 1), "/approve ");
  assert.equal(resolveSlashCommandInput("/deny abc", 0), "/deny abc");
});

test("slash command hint describes usage and misses", () => {
  assert.match(getSlashHint("/research"), /Press Enter to enter a value/);
  assert.match(getSlashHint("/artifact"), /Args:/);
  assert.match(getSlashHint("/mode"), /Args: research \| plan \| generate \| publish/);
  assert.match(getSlashHint("/approve"), /Args: <approval_id>/);
  assert.match(getSlashHint("/generate"), /Legacy alias/);
  assert.match(getSlashHint("/model"), /Press Enter to choose/);
  assert.match(getSlashHint("/does-not-exist"), /No matching command/);
  assert.match(getSlashHint("plain idea"), /Type \/ for commands/);
});
