import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import Redis from "ioredis";
import {
  ClaudeReplayRedis,
  REPLAY_TTL_SECONDS,
} from "../../../open-sse/services/claudeReplayRedis.ts";

const blocks = [
  { type: "thinking", thinking: "", signature: "signature-one" },
  { type: "redacted_thinking", data: "opaque-original" },
  { type: "thinking", thinking: "keep whitespace\n ", signature: "signature-two" },
];
const entry = { segments: [{ toolUseId: "tool_1", blocks }] };
const binding = { scope: "tenant-a:key-a", provider: "claude", model: "claude-opus-5-5" };
const secret = Buffer.alloc(32, 7);
let redis: Redis;
let processHandle: ReturnType<typeof spawn>;
let directory: string;
test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), "replay-"));
  const socket = join(directory, "redis.sock");
  processHandle = spawn(
    "redis-server",
    [
      "--port",
      "0",
      "--unixsocket",
      socket,
      "--save",
      "",
      "--appendonly",
      "no",
      "--maxmemory-policy",
      "noeviction",
    ],
    { stdio: "ignore" }
  );
  redis = new Redis(socket, { retryStrategy: () => 20, maxRetriesPerRequest: 10 });
  redis.on("error", () => {});
  await redis.ping();
});
test.after(async () => {
  redis?.disconnect();
  if (processHandle && processHandle.exitCode === null) {
    const exited = new Promise((resolve) => processHandle.once("exit", resolve));
    processHandle.kill("SIGTERM");
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
test.beforeEach(async () => {
  await redis.flushdb();
});
const store = () => new ClaudeReplayRedis(redis, secret);

test("replica B restores exact ordered blocks written by replica A", async () => {
  await store().write(binding, ["tool_1", "tool_2"], entry);
  assert.deepEqual(await store().read(binding, "tool_2"), entry);
});
test("15-minute expiry slides on use and expires after inactivity", async () => {
  assert.equal(REPLAY_TTL_SECONDS, 900);
  const a = store();
  await a.write(binding, ["tool_1"], entry);
  const [key] = await redis.keys("claude-replay:v1:*");
  await redis.expire(key, 4);
  assert.deepEqual(await a.read(binding, "tool_1"), entry);
  assert.ok((await redis.ttl(key)) >= 899);
  await redis.pexpire(key, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(a.read(binding, "tool_1"), { code: "CLAUDE_REPLAY_MISSING" });
});
test("isolation across tenant, provider and model", async () => {
  const a = store();
  await a.write(binding, ["tool_1"], entry);
  for (const change of [{ scope: "tenant-b:key-b" }, { provider: "other" }, { model: "other" }]) {
    await assert.rejects(a.read({ ...binding, ...change }, "tool_1"), {
      code: "CLAUDE_REPLAY_MISSING",
    });
  }
});
test("Redis stores encrypted payloads and opaque keys", async () => {
  await store().write(binding, ["tool_1"], entry);
  const [key] = await redis.keys("claude-replay:v1:*");
  const value = await redis.get(key);
  for (const text of ["signature-one", "opaque-original", "tenant-a", "tool_1"]) {
    assert.ok(!`${key}${value}`.includes(text));
  }
});
test("tampered or wrong-key payloads fail explicitly", async () => {
  const a = store();
  await a.write(binding, ["tool_1"], entry);
  await assert.rejects(new ClaudeReplayRedis(redis, Buffer.alloc(32, 8)).read(binding, "tool_1"));
  const [key] = await redis.keys("claude-replay:v1:*");
  await redis.set(key, "corrupt");
  await assert.rejects(a.read(binding, "tool_1"), { code: "CLAUDE_REPLAY_CORRUPT" });
});
test("tool-only reply is stored as an empty marker, distinct from missing", async () => {
  const a = store();
  const marker = { segments: [{ toolUseId: "tool_1", blocks: [] }] };
  await a.write(binding, ["tool_1"], marker);
  assert.deepEqual(await a.read(binding, "tool_1"), marker);
});
test("failed Redis writes are surfaced, never treated as success", async () => {
  const a = store();
  await redis.config("SET", "maxmemory", "1");
  try {
    await assert.rejects(a.write(binding, ["tool_1"], entry), {
      code: "CLAUDE_REPLAY_UNAVAILABLE",
    });
  } finally {
    await redis.config("SET", "maxmemory", "0");
  }
});
test("invalidation removes replay for all associated IDs", async () => {
  const a = store();
  await a.write(binding, ["tool_1", "tool_2"], entry);
  await a.remove(binding, ["tool_1", "tool_2"]);
  await assert.rejects(a.read(binding, "tool_1"), { code: "CLAUDE_REPLAY_MISSING" });
});
test("invalid or oversized signed blocks cannot be stored", async () => {
  for (const invalid of [
    [{ type: "thinking", thinking: "x", signature: "" }],
    [{ type: "thinking", thinking: "x".repeat(3 * 1024 * 1024), signature: "s" }],
  ]) {
    await assert.rejects(
      store().write(binding, ["tool_1"], { segments: [{ toolUseId: "tool_1", blocks: invalid }] })
    );
  }
  assert.equal(await redis.dbsize(), 0);
});
test("entries written before the segment layout still read back, anchored on the tool_use", async () => {
  const a = store();
  await a.write(binding, ["tool_1"], entry);
  const [key] = await redis.keys("claude-replay:v1:*");
  // Seal the previous writer's flat block list the way it did (AES-256-GCM, key as AAD).
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(key));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(blocks))), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  await redis.set(key, sealed, "EX", 900);
  assert.deepEqual(await a.read(binding, "tool_1"), entry);
});
