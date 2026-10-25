import { buildErrorBody } from "../utils/error.ts";
import { flushClaudeReplay, type ClaudeReplayContext } from "./claudeReplayContext.ts";

/** A completion cannot outrun its shared write, even if transform runs outside ALS. */
export function createClaudeReplayCompletionGate(context: ClaudeReplayContext, responses = false) {
  let failed = false;
  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (failed) return;
      try {
        await flushClaudeReplay(context);
        controller.enqueue(chunk);
      } catch {
        failed = true;
        const body = buildErrorBody(
          503,
          "Claude replay storage is unavailable. Retry later.",
          undefined,
          { code: "CLAUDE_REPLAY_UNAVAILABLE", type: "server_error" }
        );
        const event = responses
          ? `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: body.error } })}\n\n`
          : `data: ${JSON.stringify(body)}\n\n`;
        controller.enqueue(new TextEncoder().encode(event));
        controller.terminate();
      }
    },
    async flush() {
      if (!failed) await flushClaudeReplay(context);
    },
  });
}
