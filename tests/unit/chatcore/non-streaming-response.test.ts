import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const LEAF = "open-sse/handlers/chatCore/nonStreamingResponse.ts";
const BARREL = "open-sse/handlers/chatCore.ts";

test("the non-streaming path lives in its own leaf", () => {
  const leaf = read(LEAF);
  assert.match(leaf, /export async function runNonStreamingResponse\(/);
  assert.doesNotMatch(read(BARREL), /const runNonStreamingPipeline = async/);
});

test("the barrel calls the leaf and writes the carried state back", () => {
  const barrel = read(BARREL);
  assert.match(barrel, /runNonStreamingResponse\(/);
  for (const name of ["translatedBody", "currentModel", "finalBody", "providerResponse", "pipelineRecovered"]) {
    assert.match(barrel, new RegExp("carry\\." + name + "\\b"));
  }
});

test("the cost ledger stays recorded on the non-streaming path", () => {
  const leaf = read(LEAF);
  assert.match(leaf, /recordChatCallCost\(/);
  assert.match(leaf, /buildCostCtx\(/);
});

test("the barrel imports the leaf (no-undef is disabled for TS, so assert it)", () => {
  const barrel = read(BARREL);
  assert.match(barrel, /import \{\s*runNonStreamingResponse,?\s*\} from "\.\/chatCore\/nonStreamingResponse\.ts";/);
});

test("every leaf exit carries state (the leg-error exit must not return bare)", () => {
  const leaf = read(LEAF);
  const bareReturns = leaf.match(/^\s*return err;$/gm);
  assert.equal(bareReturns, null, "a bare `return err;` leaves the barrel reading .carry of undefined");
});

test("shared Claude replay barrier is awaited before any cache or idempotency save", () => {
  const leaf = read(LEAF);
  assert.match(leaf, /import \{ flushClaudeReplay \} from "\.\.\/\.\.\/services\/claudeReplayContext\.ts";/);
  const flush = leaf.indexOf("await flushClaudeReplay()");
  const semantic = leaf.indexOf("storeSemanticCacheResponse({");
  const idempotency = leaf.indexOf("await saveIdempotency(");
  assert.ok(flush > 0, "non-streaming path must await the replay write barrier");
  assert.ok(flush < semantic, "barrier must precede the semantic cache write");
  assert.ok(flush < idempotency, "barrier must precede the idempotency save (a retry would replay a 200 without replay state)");
});
