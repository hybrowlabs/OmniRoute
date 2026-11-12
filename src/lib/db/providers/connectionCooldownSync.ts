/**
 * db/providers/connectionCooldownSync.ts — Cross-instance provider-connection
 * cooldown coordination.
 *
 * Problem this closes: provider_connections.test_status/rate_limited_until/
 * last_error_type/backoff_level (the fields markAccountUnavailable() in
 * sse/services/auth.ts writes, and the fields auth.ts's candidate-selection
 * loop reads via `isAccountUnavailable(c.rateLimitedUntil)` to exclude a
 * connection from dispatch) are local-SQLite-only. Two OmniRoute instances
 * sharing the same upstream provider credentials — the horizontal-scaling
 * replica architecture — therefore discover and recover from the SAME
 * upstream rate limit independently: instance A learns connection X is
 * rate-limited from a real 429/502, but instance B's local row still says
 * "active" until B independently makes its own failing request against the
 * same already-dead connection. Verified live with matched connection IDs
 * during a real soak test (2026-09-28): the same connection ID showed
 * test_status='unavailable' on one instance and 'active' on the other at the
 * identical moment.
 *
 * Fix: mirror the cooldown-relevant fields into Redis (the SAME Redis
 * instance already deployed for QUOTA_STORE_DRIVER=redis, no new infra) on
 * every write, and overlay the freshest Redis-known state on top of the
 * local SQLite row on every read. One-way "most severe wins" merge — never
 * makes a connection MORE available than either instance's own local
 * knowledge, only ever propagates a cooldown FASTER than the 5s local cache
 * TTL would otherwise allow across processes.
 *
 * Soft dependency: reuses the exact same lazy `await import("ioredis")`
 * pattern as redisQuotaStore.ts/rateLimiter.ts (see those files' comments —
 * a static top-level import gets hoisted by esbuild in the MCP bundle).
 * Redis absent/misconfigured/down → every function here is a silent no-op;
 * this module NEVER throws into a request path and never blocks on Redis
 * (fire-and-forget writes, best-effort reads with a hard timeout).
 */
import type Redis from "ioredis";

const REDIS_URL = process.env.QUOTA_STORE_REDIS_URL?.trim() || process.env.REDIS_URL?.trim() || "";
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX?.trim() || "omniroute:";
const COOLDOWN_KEY_PREFIX = `${REDIS_KEY_PREFIX}cooldown:`;
// A cooldown mirror is only ever useful for the window it describes. Cap the
// Redis key's own TTL generously past any realistic rate_limited_until so a
// crashed writer can't leave a permanent phantom entry, but keep it well
// under "forever" so a stale/never-cleared key eventually self-heals even if
// clearConnectionCooldown() is never called for some code path.
const REDIS_KEY_TTL_SECONDS = 24 * 60 * 60; // 24h
// Best-effort reads must never add meaningful latency to the request hot
// path (this is consulted once per connection-selection pass). A live Redis
// answers in low single-digit ms; anything past this is treated as "Redis
// unavailable for this read" and falls through to the local SQLite value.
const REDIS_READ_TIMEOUT_MS = 150;

export interface ConnectionCooldownState {
  testStatus: string | null;
  rateLimitedUntil: string | null;
  lastErrorType: string | null;
  backoffLevel: number | null;
  /** ISO timestamp this state was written, used to pick the freshest of two racing writers. */
  updatedAt: string;
}

let redisClientPromise: Promise<Redis> | null = null;

export function isCooldownSyncConfigured(): boolean {
  return process.env.OMNIROUTE_DEPLOYMENT_ROLE === "replica" && REDIS_URL.length > 0;
}

/** Test-only: reset the lazy singleton between test cases. */
export function _resetCooldownSyncClientForTests(): void {
  redisClientPromise = null;
}

function getClient(): Promise<Redis> {
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const mod = await import("ioredis");
      const RedisCtor = (mod.default ?? mod) as typeof Redis;
      const client = new RedisCtor(REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        lazyConnect: false,
        retryStrategy(times) {
          return Math.min(times * 50, 2000);
        },
      });
      // Never let an unhandled 'error' event crash the process — every
      // caller below already treats a failed Redis op as "unavailable, fall
      // through to local state."
      client.on("error", () => {});
      return client;
    })();
  }
  return redisClientPromise;
}

function cooldownKey(connectionId: string): string {
  return `${COOLDOWN_KEY_PREFIX}${connectionId}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/**
 * Publish this instance's cooldown-relevant knowledge about a connection so
 * every other instance sharing the same Redis sees it on their next read.
 * Fire-and-forget: never awaited by callers on the request hot path, never
 * throws, no-op when Redis isn't configured.
 */
export function publishConnectionCooldown(
  connectionId: string,
  state: Omit<ConnectionCooldownState, "updatedAt">
): void {
  if (!connectionId || !isCooldownSyncConfigured()) return;
  const payload: ConnectionCooldownState = { ...state, updatedAt: new Date().toISOString() };
  void (async () => {
    try {
      const client = await getClient();
      await client.set(
        cooldownKey(connectionId),
        JSON.stringify(payload),
        "EX",
        REDIS_KEY_TTL_SECONDS
      );
    } catch {
      // Best-effort: a failed publish just means the next instance to hit
      // this connection discovers the same failure itself, same as today.
    }
  })();
}

/**
 * Explicit clear — mirrors clearConnectionErrorIfUnchanged's local reset so
 * a connection an instance just recovered doesn't get re-poisoned by a
 * stale Redis entry from before the recovery.
 */
export function clearConnectionCooldown(connectionId: string): void {
  if (!connectionId || !isCooldownSyncConfigured()) return;
  void (async () => {
    try {
      const client = await getClient();
      await client.del(cooldownKey(connectionId));
    } catch {
      // Best-effort; worst case a phantom cooldown lingers until its own TTL expires.
    }
  })();
}

/**
 * Read the freshest known cooldown state for one connection. Returns null on
 * any failure/timeout/missing-key/unconfigured Redis — callers treat null as
 * "no additional information, use the local row as-is."
 */
async function readConnectionCooldown(
  connectionId: string
): Promise<ConnectionCooldownState | null> {
  if (!connectionId || !isCooldownSyncConfigured()) return null;
  try {
    const client = await getClient();
    const raw = await withTimeout(client.get(cooldownKey(connectionId)), REDIS_READ_TIMEOUT_MS);
    if (!raw) return null;
    return JSON.parse(raw) as ConnectionCooldownState;
  } catch {
    return null;
  }
}

/**
 * Batch read for every connection id in one round trip (MGET) — the real
 * call shape: auth.ts's candidate-selection loop evaluates a whole pool of
 * connections per request, not one at a time.
 */
async function readConnectionCooldownsBatch(
  connectionIds: readonly string[]
): Promise<Map<string, ConnectionCooldownState>> {
  const result = new Map<string, ConnectionCooldownState>();
  if (connectionIds.length === 0 || !isCooldownSyncConfigured()) return result;
  try {
    const client = await getClient();
    const keys = connectionIds.map(cooldownKey);
    const raws = await withTimeout(client.mget(...keys), REDIS_READ_TIMEOUT_MS);
    if (!raws) return result;
    raws.forEach((raw, i) => {
      if (!raw) return;
      try {
        result.set(connectionIds[i], JSON.parse(raw) as ConnectionCooldownState);
      } catch {
        // Skip a corrupted entry; local row still wins for this connection.
      }
    });
  } catch {
    // Redis unavailable for this read — every connection falls through to its local row.
  }
  return result;
}

/**
 * "Most severe wins" merge for one row: only OVERRIDES local values that are
 * more available than what Redis knows, so a stale Redis TTL race can never
 * make a connection look BETTER than the local instance's own real
 * knowledge — it can only make it look worse (i.e. correctly excluded)
 * sooner than this instance would have discovered on its own.
 */
export function mergeCooldownIntoRow<T extends Record<string, unknown>>(
  row: T,
  remote: ConnectionCooldownState | null
): T {
  if (!remote) return row;
  const localUntilMs = parseFutureMs(row.rateLimitedUntil ?? row.rate_limited_until);
  const remoteUntilMs = parseFutureMs(remote.rateLimitedUntil);
  if (!Number.isFinite(remoteUntilMs) || remoteUntilMs! <= Date.now()) return row;
  if (Number.isFinite(localUntilMs) && localUntilMs! >= remoteUntilMs!) return row;
  const hasSnakeCase = Object.hasOwn(row, "rate_limited_until");
  return {
    ...row,
    ...(hasSnakeCase
      ? {
          rate_limited_until: remote.rateLimitedUntil,
          test_status: remote.testStatus ?? row.test_status,
          last_error_type: remote.lastErrorType ?? row.last_error_type,
          backoff_level: remote.backoffLevel ?? row.backoff_level,
        }
      : {
          rateLimitedUntil: remote.rateLimitedUntil,
          testStatus: remote.testStatus ?? row.testStatus,
          lastErrorType: remote.lastErrorType ?? row.lastErrorType,
          backoffLevel: remote.backoffLevel ?? row.backoffLevel,
        }),
  };
}

function parseFutureMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Overlay Redis-known cooldown state onto a whole batch of provider_connection
 * rows in one round trip. Called once per getRawProviderConnections/
 * getProviderConnections read — the actual read choke point every real
 * connection-selection caller (auth.ts, quotaScheduler, etc.) goes through.
 */
export async function overlayCooldownState<T extends Record<string, unknown>>(
  rows: readonly T[]
): Promise<T[]> {
  if (!isCooldownSyncConfigured() || rows.length === 0) return rows as T[];
  const ids = rows
    .map((r) => (typeof r.id === "string" ? r.id : null))
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return rows as T[];
  const remoteStates = await readConnectionCooldownsBatch(ids);
  if (remoteStates.size === 0) return rows as T[];
  return rows.map((row) => {
    const id = typeof row.id === "string" ? row.id : undefined;
    if (!id) return row;
    const remote = remoteStates.get(id);
    return remote ? mergeCooldownIntoRow(row, remote) : row;
  });
}

// Exported for the single-connection call sites (clearConnectionErrorIfUnchanged
// and any future targeted lookup) that don't already have a batch of rows to overlay.
export { readConnectionCooldown };
