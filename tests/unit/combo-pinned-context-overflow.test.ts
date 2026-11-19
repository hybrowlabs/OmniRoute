/**
 * OPS-679: a session pinned by context_cache_protection must not die on a 400
 * context overflow. The pin handler used to return any status outside
 * 401/408/429/500/502/503/504 unchanged, so a session pinned to a 200k model
 * failed on every later turn once the prompt outgrew that window. A context
 * overflow (the context_length_exceeded error class, or the pre-dispatch
 * "Input exceeds context window" rejection) now drops the pin and falls through
 * to the other combo targets, which then re-pin the session to the model that
 * serves the turn. Other 400s stay terminal.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "combo-pinned-overflow-"));
process.env.DATA_DIR = data;
process.env.APP_LOG_TO_FILE = "false";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { recordSessionModelUsage, getLastSessionModel } =
  await import("../../src/lib/db/contextHandoffs.ts");
const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
// The pin's health check must succeed; without an active connection every test
// bypasses the pinned dispatch entirely and only exercises the normal strategy.
await createProviderConnection({
  provider: "cursor",
  authType: "apikey",
  name: "pinned-overflow-fixture",
  isActive: true,
  apiKey: "fixture-only",
});

const SMALL = "cursor/auto-balance";
const LARGE = "codex/gpt-6.1-sol";
const log = { info() {}, warn() {}, debug() {}, error() {} };

function overflow400(message: string, code: string, type = "invalid_request_error") {
  return Response.json({ error: { message, code, type } }, { status: 400 });
}

test.after(async () => {
  await closeCallLogSaves(5000);
  resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Pin a session to the 200k model, then send a request whose prompt the pinned
 * model rejects as too large. Returns the served response, the models dispatched
 * in order, and the model the session is pinned to afterwards.
 */
async function pinnedTurn(
  pinnedRejection: Response,
  largerResponse: Response,
  options: { strategy?: string; signal?: AbortSignal } = {}
) {
  const name = `overflow-${Math.random().toString(36).slice(2, 8)}`;
  const combo = {
    name,
    strategy: options.strategy ?? "priority",
    context_cache_protection: 1,
    // The smaller target comes first: the strategy must not select it again.
    models: [{ model: SMALL }, { model: LARGE }],
    config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0, maxGlobalAttempts: 1 },
  };
  const sessionId = `${name}-session`;
  recordSessionModelUsage(sessionId, name, SMALL, "cursor");
  assert.equal(getLastSessionModel(sessionId, name), SMALL, "the session starts pinned");

  const calls: string[] = [];
  const response = await handleComboChat({
    combo,
    allCombos: [combo],
    relayOptions: { sessionId },
    signal: options.signal,
    body: { stream: false, messages: [{ role: "user", content: "a 300k token prompt" }] },
    hiddenModelsByProvider: new Map(),
    isModelAvailable: async () => true,
    log,
    handleSingleModel: async (_body, model) => {
      calls.push(model);
      return model === SMALL ? pinnedRejection : largerResponse;
    },
  });
  return { response, calls, pinnedAfter: getLastSessionModel(sessionId, name) };
}

test("a pinned 200k model that overflows on a 300k prompt falls through to the larger target and the pin moves", async () => {
  const served = Response.json({
    choices: [{ message: { content: "served by the larger window" } }],
  });
  const { response, calls, pinnedAfter } = await pinnedTurn(
    overflow400(
      "Input exceeds context window for cursor/auto-balance: estimated 300000 input tokens, limit 200000. Reduce the prompt or route to a model with a larger context window.",
      "context_length_exceeded"
    ),
    served
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [SMALL, LARGE], "the pin is tried, then the larger target");
  assert.equal(pinnedAfter, LARGE, "the session is re-pinned to the model that served the turn");
  await response.text();
});

test("a provider context_overflow body on the pinned model also drops the pin", async () => {
  const served = Response.json({ choices: [{ message: { content: "ok" } }] });
  const { response, calls, pinnedAfter } = await pinnedTurn(
    overflow400("context overflow: prompt too large for the context window", "context_overflow"),
    served
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [SMALL, LARGE]);
  assert.equal(pinnedAfter, LARGE);
  await response.text();
});

test("a pinned 400 that is not a context overflow stays terminal and keeps the pin", async () => {
  const served = Response.json({ choices: [{ message: { content: "must not be reached" } }] });
  const { response, calls, pinnedAfter } = await pinnedTurn(
    overflow400("invalid request: tool name is malformed", "invalid_request"),
    served
  );

  assert.equal(response.status, 400, "other 400s are returned to the client");
  assert.deepEqual(calls, [SMALL], "no fall-through to the larger target");
  assert.equal(pinnedAfter, SMALL, "the pin is unchanged");
  const body = await response.json();
  assert.match(JSON.stringify(body), /tool name is malformed/);
});

for (const message of [
  "max_tokens must be a positive integer",
  "context window must be a positive integer",
  "maximum input tokens per minute exceeded",
]) {
  test(`parameter/rate validation stays terminal: ${message}`, async () => {
    const rejection = overflow400(message, "invalid_request");
    const expectedBody = await rejection.clone().text();
    const { response, calls, pinnedAfter } = await pinnedTurn(rejection, Response.json({}));
    assert.equal(response.status, 400);
    assert.deepEqual(calls, [SMALL]);
    assert.equal(pinnedAfter, SMALL);
    assert.equal(await response.text(), expectedBody);
  });
}

test("round-robin excludes the overflowing pin before rotating and re-pins the larger target", async () => {
  const { response, calls, pinnedAfter } = await pinnedTurn(
    overflow400("too large", "context_overflow"),
    Response.json({ choices: [{ message: { content: "ok" } }] }),
    { strategy: "round-robin" }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [SMALL, LARGE]);
  assert.equal(pinnedAfter, LARGE);
  await response.text();
});

for (const abort of [false, true]) {
  test(`incomplete pinned 400 body is bounded (abort=${abort})`, async () => {
    const client = new AbortController();
    let upstream: ReadableStreamDefaultController<Uint8Array>;
    const rejection = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
          controller.enqueue(new TextEncoder().encode('{"error":'));
        },
      }),
      { status: 400 }
    );
    const turn = pinnedTurn(rejection, Response.json({}), { signal: client.signal });
    const abortTimer = abort ? setTimeout(() => client.abort(), 30) : null;
    // Always close the source so a failing baseline test cannot hang the runner.
    const cleanupTimer = setTimeout(() => upstream.close(), 1800);
    const started = Date.now();
    try {
      const { response, calls, pinnedAfter } = await turn;
      assert.ok(Date.now() - started < 1500, "classification must not wait for upstream EOF");
      assert.equal(response.status, abort ? 499 : 400);
      assert.deepEqual(calls, [SMALL]);
      assert.equal(pinnedAfter, SMALL);
      void response.body?.cancel().catch(() => {});
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      clearTimeout(cleanupTimer);
      try {
        upstream.close();
      } catch {
        /* already closed */
      }
    }
  });
}
