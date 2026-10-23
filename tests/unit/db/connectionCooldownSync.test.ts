// tests/unit/db/connectionCooldownSync.test.ts
//
// Real tests, not mocks: publishConnectionCooldown/overlayCooldownState are
// exercised against a real ioredis connection (this repo already deploys a
// real Redis for QUOTA_STORE_DRIVER=redis — REDIS_URL/QUOTA_STORE_REDIS_URL
// must point at a reachable instance for this file to run for real; if
// unset, isCooldownSyncConfigured() is false and every function under test
// is a documented no-op, which the first test group covers explicitly).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  isCooldownSyncConfigured,
  publishConnectionCooldown,
  clearConnectionCooldown,
  overlayCooldownState,
  mergeCooldownIntoRow,
  _resetCooldownSyncClientForTests,
} from "../../../src/lib/db/providers/connectionCooldownSync.ts";

// publishConnectionCooldown/clearConnectionCooldown are deliberately
// fire-and-forget (the request hot path must never await a Redis write).
// Tests poll for the actual condition — the write having landed — instead
// of guessing a fixed delay.
async function pollUntil<T>(
  check: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 3000, intervalMs = 20 } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("mergeCooldownIntoRow (pure logic, no Redis)", () => {
  test("does nothing when remote is null", () => {
    const row = { id: "a", rate_limited_until: null };
    assert.deepEqual(mergeCooldownIntoRow(row, null), row);
  });

  test("does not override a local cooldown that already extends past the remote one", () => {
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    const nearFuture = new Date(Date.now() + 5_000).toISOString();
    const row = { id: "a", rate_limited_until: farFuture, test_status: "unavailable" };
    const merged = mergeCooldownIntoRow(row, {
      testStatus: "unavailable",
      rateLimitedUntil: nearFuture,
      lastErrorType: "rate_limited",
      backoffLevel: 1,
      updatedAt: new Date().toISOString(),
    });
    // Local already knows a LONGER cooldown than the remote one — remote must not shorten it.
    assert.equal(merged.rate_limited_until, farFuture);
  });

  test("overrides a stale/absent local cooldown with a fresher remote one", () => {
    const remoteUntil = new Date(Date.now() + 60_000).toISOString();
    const row = { id: "a", rate_limited_until: null, test_status: "active" };
    const merged = mergeCooldownIntoRow(row, {
      testStatus: "unavailable",
      rateLimitedUntil: remoteUntil,
      lastErrorType: "rate_limited",
      backoffLevel: 1,
      updatedAt: new Date().toISOString(),
    });
    assert.equal(merged.rate_limited_until, remoteUntil);
    assert.equal(merged.test_status, "unavailable");
    assert.equal(merged.last_error_type, "rate_limited");
    assert.equal(merged.backoff_level, 1);
  });

  test("ignores an already-expired remote cooldown", () => {
    const expiredUntil = new Date(Date.now() - 5_000).toISOString();
    const row = { id: "a", rate_limited_until: null };
    const merged = mergeCooldownIntoRow(row, {
      testStatus: "unavailable",
      rateLimitedUntil: expiredUntil,
      lastErrorType: "rate_limited",
      backoffLevel: 1,
      updatedAt: new Date().toISOString(),
    });
    assert.equal(merged.rate_limited_until, null);
  });

  test("preserves camelCase shape for rows that use it instead of snake_case", () => {
    const remoteUntil = new Date(Date.now() + 60_000).toISOString();
    const row = { id: "a", rateLimitedUntil: null, testStatus: "active" };
    const merged = mergeCooldownIntoRow(row, {
      testStatus: "unavailable",
      rateLimitedUntil: remoteUntil,
      lastErrorType: "rate_limited",
      backoffLevel: 2,
      updatedAt: new Date().toISOString(),
    });
    assert.equal(merged.rateLimitedUntil, remoteUntil);
    assert.equal(merged.testStatus, "unavailable");
    assert.equal((merged as Record<string, unknown>).backoffLevel, 2);
  });
});

describe("Redis-backed behavior", () => {
  const redisReachable = isCooldownSyncConfigured();

  before(() => {
    _resetCooldownSyncClientForTests();
  });
  after(() => {
    _resetCooldownSyncClientForTests();
  });

  test("isCooldownSyncConfigured reflects REDIS_URL/QUOTA_STORE_REDIS_URL presence", () => {
    const expected =
      process.env.OMNIROUTE_DEPLOYMENT_ROLE === "replica" &&
      Boolean(process.env.QUOTA_STORE_REDIS_URL?.trim() || process.env.REDIS_URL?.trim());
    assert.equal(isCooldownSyncConfigured(), expected);
  });

  test(
    "publishConnectionCooldown -> overlayCooldownState round-trips a real cross-instance write/read",
    { skip: !redisReachable },
    async () => {
      const connectionId = `test-cooldown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const until = new Date(Date.now() + 30_000).toISOString();

      publishConnectionCooldown(connectionId, {
        testStatus: "unavailable",
        rateLimitedUntil: until,
        lastErrorType: "rate_limited",
        backoffLevel: 1,
      });

      const overlaid = await pollUntil(
        () =>
          overlayCooldownState([
            { id: connectionId, rate_limited_until: null, test_status: "active" },
          ]),
        (rows) => rows[0].rate_limited_until !== null
      );
      assert.equal(overlaid[0].rate_limited_until, until);
      assert.equal(overlaid[0].test_status, "unavailable");

      clearConnectionCooldown(connectionId);

      const overlaidAfterClear = await pollUntil(
        () =>
          overlayCooldownState([
            { id: connectionId, rate_limited_until: null, test_status: "active" },
          ]),
        (rows) => rows[0].rate_limited_until === null
      );
      // Cleared — the local row's own (unmodified) state must survive untouched.
      assert.equal(overlaidAfterClear[0].rate_limited_until, null);
    }
  );

  test(
    "overlayCooldownState is a pure pass-through when Redis has no entry for the id",
    { skip: !redisReachable },
    async () => {
      const rows = [{ id: `never-published-${Date.now()}`, rate_limited_until: null }];
      const result = await overlayCooldownState(rows);
      assert.deepEqual(result, rows);
    }
  );

  test("every function is a documented no-op when Redis is not configured", async () => {
    if (redisReachable) return; // this environment has Redis; covered by the tests above instead.
    const rows = [{ id: "x", rate_limited_until: null }];
    assert.deepEqual(await overlayCooldownState(rows), rows);
    // Must not throw even though there is nothing to connect to.
    assert.doesNotThrow(() =>
      publishConnectionCooldown("x", {
        testStatus: "unavailable",
        rateLimitedUntil: null,
        lastErrorType: null,
        backoffLevel: null,
      })
    );
    assert.doesNotThrow(() => clearConnectionCooldown("x"));
  });
});
