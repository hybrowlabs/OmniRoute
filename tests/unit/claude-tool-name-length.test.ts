import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseExecutor } from "../../open-sse/executors/base.ts";
import { shortenClaudeToolNames } from "../../open-sse/services/claudeCodeToolRemapper.ts";
import {
  mergeResponseToolNameMap,
  restoreNonStreamingToolNames,
} from "../../open-sse/handlers/chatCore/passthroughToolNames.ts";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.ts";

const LONG_NAME =
  "mcp__paperclip-assigned__mcp_app-gallery-netlify-aafd6ae8-e891-4783-9eab-aa784e2b908c-c140260a_netlify-extension-services-updater";

type Block = Record<string, unknown> & { content?: Block[] };
type Body = Record<string, unknown> & {
  tools: (Record<string, unknown> & { name: string })[];
  messages?: { role: string; content: Block[] }[];
};

class ClaudeExecutor extends BaseExecutor {
  constructor() {
    super("claude", { baseUrls: ["https://api.anthropic.com/v1/messages"] });
  }
  needsRefresh() {
    return false;
  }
  async transformRequest(_model: string, body: Body) {
    return { ...body };
  }
}

for (const stream of [false, true]) {
  test(`129-character MCP tool round-trips through native Claude ${stream ? "SSE" : "JSON"}`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const body: Body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_prior", name: LONG_NAME, input: { name: LONG_NAME } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_prior", content: "done" },
            { type: "text", text: "Call the tool again." },
          ],
        },
      ],
      tools: [
        {
          name: LONG_NAME,
          description: "A harmless diagnostic tool",
          input_schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      ],
      tool_choice: { type: "tool", name: LONG_NAME },
      max_tokens: 256,
    };
    globalThis.fetch = async (_url, init = {}) => {
      const wire = JSON.parse(String(init.body));
      const name = wire.tools[0].name;
      if (name.length > 128) {
        return Response.json(
          { error: { message: "tools.0.custom.name: String should have at most 128 characters" } },
          { status: 400 }
        );
      }
      assert.equal(wire.tool_choice.name, name);
      assert.equal(wire.messages[0].content[0].name, name);
      assert.equal(
        wire.messages[0].content[0].input.name,
        LONG_NAME,
        "tool arguments are not names to rewrite"
      );
      const content = { type: "tool_use", id: "toolu_result", name, input: { ok: true } };
      if (!stream) {
        return Response.json({
          id: "msg_result",
          type: "message",
          role: "assistant",
          model: wire.model,
          content: [content],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 5 },
        });
      }
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_result",
            type: "message",
            role: "assistant",
            model: wire.model,
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { ...content, input: {} } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"ok":' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "true}" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      const bytes = new TextEncoder().encode(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 19) controller.enqueue(bytes.slice(i, i + 19));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    };

    const result = await new ClaudeExecutor().execute({
      model: "claude-opus-5-5",
      body,
      stream,
      credentials: { accessToken: "sk-ant-oat-synthetic-tool-name-test" },
    });
    assert.equal(result.response.status, 200, "the provider must accept the bounded name");
    if (stream) {
      const map = mergeResponseToolNameMap(null, result.transformedBody);
      const text = await new Response(
        result.response.body!.pipeThrough(createPassthroughStreamWithLogger("claude", null, map))
      ).text();
      const events = text
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)));
      const tool = events.find(
        (event) => event.type === "content_block_start" && event.content_block?.type === "tool_use"
      ).content_block;
      assert.equal(tool.name, LONG_NAME);
      assert.equal(tool.id, "toolu_result");
      assert.deepEqual(
        JSON.parse(
          events
            .filter((event) => event.delta?.type === "input_json_delta")
            .map((event) => event.delta.partial_json)
            .join("")
        ),
        { ok: true }
      );
    } else {
      const [response] = restoreNonStreamingToolNames(
        await result.response.json(),
        null,
        result.transformedBody,
        true
      );
      assert.deepEqual(response.content, [
        { type: "tool_use", id: "toolu_result", name: LONG_NAME, input: { ok: true } },
      ]);
    }
    assert.equal(
      body.tools[0].name,
      LONG_NAME,
      "fallback/retry input retains the caller's namespace"
    );
  });
}

test("length aliases reserve existing names, survive collisions, and do not depend on tool order", () => {
  const initial: Body = { tools: [{ name: LONG_NAME }] };
  shortenClaudeToolNames(initial);
  const occupied = initial.tools[0].name;
  const exactBoundary = "mcp__boundary__".padEnd(128, "x");
  const names = [LONG_NAME, `${LONG_NAME}2`, occupied, exactBoundary];
  const make = (order: string[]): Body => ({ tools: order.map((name) => ({ name })) });
  const request = make(names);
  shortenClaudeToolNames(request);
  const wireNames = request.tools.map((tool) => tool.name);
  assert.equal(new Set(wireNames).size, names.length);
  assert(wireNames.every((name: string) => name.length <= 128));
  assert.equal(wireNames[2], occupied);
  assert.equal(wireNames[3], exactBoundary);
  const [response] = restoreNonStreamingToolNames(
    { content: wireNames.map((name: string) => ({ type: "tool_use", name, input: {} })) },
    null,
    request,
    true
  );
  assert.deepEqual(
    (response.content as { name: string }[]).map((tool) => tool.name),
    names
  );
  const reversed = make([...names].reverse());
  shortenClaudeToolNames(reversed);
  assert.deepEqual(reversed.tools.map((tool) => tool.name).reverse(), wireNames);
});

test("deferred tool references share the same bounded name without rewriting data", () => {
  const request: Body = {
    tools: [{ name: LONG_NAME }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_search",
            content: [
              { type: "tool_reference", tool_name: LONG_NAME },
              { type: "text", text: LONG_NAME },
            ],
          },
        ],
      },
    ],
  };
  shortenClaudeToolNames(request);
  const content = request.messages![0].content[0].content!;
  assert.equal(content[0].tool_name, request.tools[0].name);
  assert.equal(content[1].text, LONG_NAME);
});
