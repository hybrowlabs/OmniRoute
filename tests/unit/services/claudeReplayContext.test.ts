import test from "node:test";
import assert from "node:assert/strict";
import {
  withClaudeReplay,
  currentClaudeReplay,
  flushClaudeReplay,
} from "../../../open-sse/services/claudeReplayContext.ts";
import {
  storeClaudeThinkingBlocks,
  restoreClaudeThinkingBlocks,
} from "../../../open-sse/services/claudeThinkingStore.ts";
const blocks = [{ type: "thinking" as const, thinking: "", signature: "signed" }];
const binding = { scope: "key-a", provider: "claude", model: "claude-opus-5-5" };
const args = {
  provider: binding.provider,
  model: binding.model,
  toolUseIds: ["toolu_one"],
  blocks,
};
function backend() {
  const data = new Map<string, typeof blocks>();
  return {
    async write(b, ids, value) {
      for (const id of ids) data.set(b.scope + id, structuredClone(value));
    },
    async read(b, id) {
      if (!data.has(b.scope + id)) {
        const e = new Error("missing");
        Object.assign(e, { code: "CLAUDE_REPLAY_MISSING" });
        throw e;
      }
      return structuredClone(data.get(b.scope + id));
    },
    async remove(b, ids) {
      for (const id of ids) data.delete(b.scope + id);
    },
  };
}
test("store and restore are connected across independent request contexts", async () => {
  const store = backend();
  await withClaudeReplay(store, binding, {}, async () => {
    storeClaudeThinkingBlocks(args);
    await flushClaudeReplay();
  });
  await withClaudeReplay(
    store,
    binding,
    { input: [{ type: "function_call", call_id: "toolu_one" }] },
    async () => {
      assert.deepEqual(restoreClaudeThinkingBlocks(args), blocks);
    }
  );
});
test("missing state errors instead of falling through to local cache or placeholder", async () => {
  await withClaudeReplay(
    backend(),
    binding,
    { input: [{ type: "function_call", call_id: "toolu_one" }] },
    async () => {
      assert.throws(() => restoreClaudeThinkingBlocks(args), { code: "CLAUDE_REPLAY_MISSING" });
    }
  );
});
test("write barrier rejects before successful completion", async () => {
  const store = backend();
  store.write = async () => {
    throw new Error("write failed");
  };
  await withClaudeReplay(store, binding, {}, async () => {
    storeClaudeThinkingBlocks(args);
    await assert.rejects(flushClaudeReplay());
  });
});
test("concurrent request scopes cannot leak blocks", async () => {
  const store = backend();
  await Promise.all(
    ["a", "b"].map((scope) =>
      withClaudeReplay(store, { ...binding, scope }, {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(currentClaudeReplay()?.binding.scope, scope);
      })
    )
  );
});

test("actual stream capture and request converter preserve signed blocks across contexts", async () => {
  const { claudeToOpenAIResponse } =
    await import("../../../open-sse/translator/response/claude-to-openai.ts");
  const { openaiToClaudeRequest } =
    await import("../../../open-sse/translator/request/openai-to-claude.ts");
  const { prepareClaudeRequest } =
    await import("../../../open-sse/translator/helpers/claudeHelper.ts");
  const store = backend();
  await withClaudeReplay(store, binding, {}, async () => {
    const state = {
      provider: "claude",
      model: binding.model,
      toolCalls: new Map(),
      suppressThinkClose: true,
    };
    for (const event of [
      { type: "message_start", message: { id: "msg_test", model: binding.model } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_one", name: "shell" },
      },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ])
      claudeToOpenAIResponse(event, state);
    await flushClaudeReplay();
  });
  const body = {
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      {
        role: "assistant",
        tool_calls: [
          { id: "toolu_one", type: "function", function: { name: "shell", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_one", content: "ok" },
    ],
  };
  await withClaudeReplay(store, binding, body, async () => {
    const translated = openaiToClaudeRequest(binding.model, body, true, { _provider: "claude" });
    prepareClaudeRequest(translated, "claude", false, binding.model);
    assert.deepEqual(
      translated.messages[0].content.filter((x) => x.type === "thinking"),
      blocks
    );
  });
});
test("tool-only marker prevents placeholder fabrication in enabled thinking", async () => {
  const { openaiToClaudeRequest } =
    await import("../../../open-sse/translator/request/openai-to-claude.ts");
  const { prepareClaudeRequest } =
    await import("../../../open-sse/translator/helpers/claudeHelper.ts");
  const store = backend();
  await withClaudeReplay(store, binding, {}, async () => {
    storeClaudeThinkingBlocks({ ...args, blocks: [] });
    await flushClaudeReplay();
  });
  const body = {
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [
      {
        role: "assistant",
        tool_calls: [
          { id: "toolu_one", type: "function", function: { name: "shell", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_one", content: "ok" },
    ],
  };
  await withClaudeReplay(store, binding, body, async () => {
    const translated = openaiToClaudeRequest(binding.model, body, true, { _provider: "claude" });
    prepareClaudeRequest(translated, "claude", false, binding.model);
    assert.deepEqual(
      translated.messages[0].content.map((x) => x.type),
      ["tool_use"]
    );
  });
});
test("completion gate waits for persistence and emits explicit failure instead of completed", async () => {
  const { createClaudeReplayCompletionGate } =
    await import("../../../open-sse/services/claudeReplayCompletion.ts");
  const store = backend();
  store.write = async () => {
    throw new Error("private redis error");
  };
  await withClaudeReplay(store, binding, {}, async () => {
    storeClaudeThinkingBlocks(args);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("event: response.completed\n\n"));
        c.close();
      },
    });
    const output = await new Response(
      stream.pipeThrough(createClaudeReplayCompletionGate(currentClaudeReplay()!, true))
    ).text();
    assert.match(output, /response.failed/);
    assert.doesNotMatch(output, /response.completed|private redis error/);
  });
});
test("completion is held until delayed Redis write is acknowledged", async () => {
  const { createClaudeReplayCompletionGate } =
    await import("../../../open-sse/services/claudeReplayCompletion.ts");
  const store = backend();
  let release!: () => void;
  store.write = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  await withClaudeReplay(store, binding, {}, async () => {
    storeClaudeThinkingBlocks(args);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("completed"));
        c.close();
      },
    });
    let finished = false;
    const output = new Response(
      stream.pipeThrough(createClaudeReplayCompletionGate(currentClaudeReplay()!))
    )
      .text()
      .then((text) => {
        finished = true;
        return text;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(finished, false);
    release();
    assert.equal(await output, "completed");
  });
});
test("signature validation failure remains visible even if a best-effort caller catches it", async () => {
  await withClaudeReplay(backend(), binding, {}, async () => {
    try {
      storeClaudeThinkingBlocks({
        ...args,
        blocks: [{ type: "thinking", thinking: "x", signature: "" }],
      });
    } catch {}
    await assert.rejects(flushClaudeReplay(), { code: "CLAUDE_REPLAY_CORRUPT" });
  });
});
test("no shared mode means legacy behavior remains available", () => {
  assert.equal(currentClaudeReplay(), undefined);
});
test("Responses custom-tool calls hydrate the same replay state", async () => {
  const store = backend();
  await withClaudeReplay(store, binding, {}, async () => {
    storeClaudeThinkingBlocks(args);
    await flushClaudeReplay();
  });
  await withClaudeReplay(
    store,
    binding,
    { input: [{ type: "custom_tool_call", call_id: "toolu_one" }] },
    async () => {
      assert.deepEqual(restoreClaudeThinkingBlocks(args), blocks);
    }
  );
});
