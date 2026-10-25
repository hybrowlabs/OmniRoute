import { AsyncLocalStorage } from "node:async_hooks";
import Redis from "ioredis";
import {
  ClaudeReplayError,
  ClaudeReplayRedis,
  type ReplayBinding,
  type ReplayBlocks,
} from "./claudeReplayRedis.ts";

type Backend = Pick<ClaudeReplayRedis, "read" | "write" | "remove">;
export type ClaudeReplayContext = {
  backend: Backend;
  binding: ReplayBinding;
  entries: Map<string, ReplayBlocks | null>;
  restored: WeakSet<object>;
  pending: Promise<void>[];
  failure?: ClaudeReplayError;
};
const contexts = new AsyncLocalStorage<ClaudeReplayContext>();
export const currentClaudeReplay = () => contexts.getStore();
export function runClaudeReplay<T>(context: ClaudeReplayContext | undefined, fn: () => T): T {
  return context ? contexts.run(context, fn) : fn();
}

function historyToolIds(body: unknown): string[] {
  const root = body as { input?: unknown; messages?: unknown } | null;
  const ids = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === "string" && id.length <= 1024) ids.add(id);
  };
  for (const list of [root?.input, root?.messages]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "function_call" || item.type === "custom_tool_call") add(item.call_id);
      if (item.role !== "assistant") continue;
      if (Array.isArray(item.tool_calls)) for (const call of item.tool_calls) add(call?.id);
      if (Array.isArray(item.content))
        for (const block of item.content) if (block?.type === "tool_use") add(block.id);
    }
  }
  if (ids.size > 1024) throw new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
  return [...ids];
}
export async function withClaudeReplay<T>(
  backend: Backend,
  binding: ReplayBinding,
  body: unknown,
  fn: () => Promise<T>
): Promise<T> {
  const context: ClaudeReplayContext = {
    backend,
    binding,
    entries: new Map(),
    restored: new WeakSet(),
    pending: [],
  };
  let retainedBytes = 0;
  // Sequential reads bound memory and prevent a large history flooding Redis.
  for (const id of historyToolIds(body)) {
    try {
      const blocks = await backend.read(binding, id);
      retainedBytes += Buffer.byteLength(JSON.stringify(blocks));
      if (retainedBytes > 64 * 1024 * 1024)
        throw new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
      context.entries.set(id, blocks);
    } catch (error) {
      if ((error as { code?: string })?.code !== "CLAUDE_REPLAY_MISSING") throw error;
      context.entries.set(id, null);
    }
  }
  return contexts.run(context, fn);
}
export function queueClaudeReplay(context: ClaudeReplayContext, operation: Promise<void>): void {
  // Attach a handler immediately; retain the rejection for the completion barrier.
  operation.catch(() => {});
  context.pending.push(operation);
}
export async function flushClaudeReplay(context = currentClaudeReplay()): Promise<void> {
  if (!context) return;
  if (context.failure) throw context.failure;
  const pending = context.pending.splice(0);
  try {
    await Promise.all(pending);
  } catch {
    context.failure = new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
    throw context.failure;
  }
}
export function isSharedRestoredThinking(block: object): boolean {
  return currentClaudeReplay()?.restored.has(block) ?? false;
}
export function hasSharedToolOnlyReply(content: unknown[]): boolean {
  const context = currentClaudeReplay();
  if (!context) return false;
  const ids = content
    .filter((b) => (b as { type?: string })?.type === "tool_use")
    .map((b) => (b as { id: string }).id);
  return ids.length > 0 && ids.every((id) => context.entries.get(id)?.length === 0);
}
let backend: Backend | undefined;
export function configuredClaudeReplay(): Backend | undefined {
  const url = process.env.CLAUDE_REPLAY_REDIS_URL;
  if (!url) return undefined;
  if (backend) return backend;
  const encoded = process.env.CLAUDE_REPLAY_ENCRYPTION_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(encoded)) throw new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
  redis.on("error", () => {}); // Errors propagate through awaited operations, without logging credentials.
  // Lazy connect + disabled offline queue would reject the first command. Explicit
  // connection readiness is awaited by the adapter below on every operation.
  let ready: Promise<void> | undefined;
  const ensure = async () => {
    if (redis.status === "ready") return;
    if (!ready)
      ready = redis.connect().finally(() => {
        ready = undefined;
      });
    try {
      await ready;
    } catch {
      throw new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
    }
  };
  const store = new ClaudeReplayRedis(redis, Buffer.from(encoded, "hex"));
  backend = {
    read: async (...args: Parameters<typeof store.read>) => {
      await ensure();
      return store.read(...args);
    },
    write: async (...args: Parameters<typeof store.write>) => {
      await ensure();
      return store.write(...args);
    },
    remove: async (...args: Parameters<typeof store.remove>) => {
      await ensure();
      return store.remove(...args);
    },
  };
  return backend;
}
