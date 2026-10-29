import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type Redis from "ioredis";
import { z } from "zod";

export const REPLAY_TTL_SECONDS = 15 * 60;
const MAX_BYTES = 2 * 1024 * 1024;
const blocksSchema = z
  .array(
    z.discriminatedUnion("type", [
      z
        .object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().min(1) })
        .strict(),
      z.object({ type: z.literal("redacted_thinking"), data: z.string().min(1) }).strict(),
    ])
  )
  .max(512);
export type ReplayBlocks = z.infer<typeof blocksSchema>;
export type ReplayBinding = { scope: string; provider: string; model: string };
const bindingSchema = z.object({
  scope: z.string().min(1).max(1024),
  provider: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
});

export class ClaudeReplayError extends Error {
  readonly statusCode: number;
  readonly errorType = "claude_replay_error";
  constructor(
    readonly code: "CLAUDE_REPLAY_MISSING" | "CLAUDE_REPLAY_CORRUPT" | "CLAUDE_REPLAY_UNAVAILABLE"
  ) {
    super(
      code === "CLAUDE_REPLAY_MISSING"
        ? "Claude replay state expired or is unavailable. Start a new conversation."
        : "Claude replay storage is unavailable. Retry later."
    );
    this.statusCode = code === "CLAUDE_REPLAY_MISSING" ? 409 : 503;
  }
}

/** Shared authoritative store; no process-local fallback can mask failed writes. */
export class ClaudeReplayRedis {
  constructor(
    private readonly redis: Redis,
    private readonly secret: Buffer
  ) {
    if (secret.length !== 32) throw new Error("Claude replay encryption requires a 32-byte key");
  }
  private key(binding: ReplayBinding, toolId: string): string {
    bindingSchema.parse(binding);
    z.string().min(1).max(1024).parse(toolId);
    return (
      "claude-replay:v1:" +
      createHash("sha256")
        .update(
          JSON.stringify([
            binding.scope,
            binding.provider.trim().toLowerCase(),
            binding.model
              .trim()
              .toLowerCase()
              .split("/")
              .pop()
              ?.replace(/-\d{8}$/, ""),
            toolId,
          ])
        )
        .digest("hex")
    );
  }
  async write(binding: ReplayBinding, toolIds: string[], input: unknown): Promise<void> {
    const blocks = blocksSchema.parse(input);
    const plain = Buffer.from(JSON.stringify(blocks));
    if (plain.length > MAX_BYTES) throw new Error("Claude replay entry exceeds size limit");
    const ids = z
      .array(z.string().min(1).max(1024))
      .min(1)
      .max(128)
      .parse([...new Set(toolIds)]);
    if (plain.length * ids.length > 64 * 1024 * 1024) {
      throw new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
    }
    const batch = this.redis.multi();
    for (const id of ids) {
      const key = this.key(binding, id);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.secret, iv);
      cipher.setAAD(Buffer.from(key));
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
      batch.set(key, sealed, "EX", REPLAY_TTL_SECONDS);
    }
    try {
      const result = await batch.exec();
      if (!result || result.some(([error]) => error)) throw new Error("Replay write rejected");
    } catch {
      throw new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
    }
  }
  async read(binding: ReplayBinding, toolId: string): Promise<ReplayBlocks> {
    const key = this.key(binding, toolId);
    let sealed: string | null;
    try {
      sealed = await this.redis.getex(key, "EX", REPLAY_TTL_SECONDS);
    } catch {
      throw new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
    }
    if (sealed === null) throw new ClaudeReplayError("CLAUDE_REPLAY_MISSING");
    try {
      if (sealed.length > (MAX_BYTES + 28) * 2) throw new Error("Oversized envelope");
      const data = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.secret, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(data.subarray(12, 28));
      return blocksSchema.parse(
        JSON.parse(
          Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8")
        )
      );
    } catch {
      throw new ClaudeReplayError("CLAUDE_REPLAY_CORRUPT");
    }
  }
  async remove(binding: ReplayBinding, toolIds: string[]): Promise<void> {
    if (!toolIds.length) return;
    try {
      await this.redis.del(...toolIds.map((id) => this.key(binding, id)));
    } catch {
      throw new ClaudeReplayError("CLAUDE_REPLAY_UNAVAILABLE");
    }
  }
}
