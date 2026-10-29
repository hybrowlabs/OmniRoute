import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pomerado-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
const { APPLY_PATCH_FUNCTION, restoreApplyPatchResponse } =
  await import("../../open-sse/executors/codex/applyPatchBridge.ts");
const { normalizeCodexTools } = await import("../../open-sse/executors/codex/tools.ts");

function prepare(body: Record<string, unknown>) {
  return new CodexExecutor().transformRequest(
    "gpt-6.1-sol",
    {
      _nativeCodexPassthrough: true,
      model: "gpt-6.1-sol",
      input: [{ role: "user", content: "Build a synthetic integration" }],
      ...body,
    },
    true,
    {} as never
  ) as Record<string, unknown>;
}

test("Pomerado native apply_patch declaration and allowed choice survive together", () => {
  const tools = [{ type: "apply_patch" }];
  const tool_choice = { type: "allowed_tools", mode: "auto", tools };
  const result = prepare({ tools, tool_choice });
  assert.equal((result.tools as Array<Record<string, unknown>>)[0].name, APPLY_PATCH_FUNCTION);
  assert.equal((result.tools as Array<Record<string, unknown>>)[0].type, "function");
  assert.deepEqual(result.tool_choice, {
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: APPLY_PATCH_FUNCTION }],
  });
});

test("native apply_patch call and result survive continuation", () => {
  const call = {
    type: "apply_patch_call",
    call_id: "call_patch",
    status: "completed",
    operation: { type: "create_file", path: "synthetic.txt", diff: "+synthetic" },
  };
  const output = {
    type: "apply_patch_call_output",
    call_id: "call_patch",
    status: "completed",
    output: "Created synthetic.txt",
  };
  const result = prepare({ tools: [{ type: "apply_patch" }], input: [call, output] });
  assert.deepEqual(result.input, [
    {
      type: "function_call",
      call_id: call.call_id,
      status: "completed",
      name: APPLY_PATCH_FUNCTION,
      arguments: JSON.stringify({ operation: call.operation }),
    },
    {
      type: "function_call_output",
      call_id: output.call_id,
      output: JSON.stringify({ status: "completed", output: output.output }),
    },
  ]);
});

test("unsupported cache hints are removed only from protocol envelopes", () => {
  const properties = {
    prompt_cache_breakpoint: { type: "boolean" },
    prompt_cache_options: { type: "object" },
  };
  const input = [
    {
      role: "user",
      prompt_cache_breakpoint: true,
      content: [{ type: "input_text", text: "synthetic", prompt_cache_breakpoint: true }],
    },
  ];
  const tools = [
    {
      type: "function",
      name: "finish_build",
      prompt_cache_breakpoint: true,
      parameters: { type: "object", properties },
    },
  ];
  const body = {
    input,
    tools,
    prompt_cache_options: { retention: "24h" },
    prompt_cache_breakpoint: true,
  };
  const result = prepare(body);
  assert.equal(result.prompt_cache_options, undefined);
  assert.equal(result.prompt_cache_breakpoint, undefined);
  const messages = result.input as Array<Record<string, unknown>>;
  assert.equal(messages[0].prompt_cache_breakpoint, undefined);
  assert.equal(
    (messages[0].content as Array<Record<string, unknown>>)[0].prompt_cache_breakpoint,
    undefined
  );
  const normalized = result.tools as Array<Record<string, unknown>>;
  assert.equal(normalized[0].prompt_cache_breakpoint, undefined);
  assert.deepEqual((normalized[0].parameters as Record<string, unknown>).properties, properties);
  assert.equal(body.prompt_cache_breakpoint, true, "caller payload must not be mutated");
});

test("unknown tool types remain filtered and custom apply_patch stays intact", () => {
  const custom = { type: "custom", name: "apply_patch", format: { type: "text" } };
  const body = { tools: [{ type: "unrecognized_tool" }, custom] };
  normalizeCodexTools(body, { preserveCustomTools: true });
  assert.deepEqual(body.tools, [custom]);
});

test("patch function streaming restores native calls without leaking bridge arguments", async () => {
  const operation = { type: "create_file", path: "synthetic.txt", diff: "+synthetic" };
  const item = {
    type: "function_call",
    id: "fc_patch",
    call_id: "call_patch",
    name: APPLY_PATCH_FUNCTION,
    arguments: JSON.stringify({ operation }),
    status: "completed",
  };
  const events = [
    { type: "response.created", response: { id: "resp_test", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    { type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments },
    { type: "response.function_call_arguments.done", item_id: item.id, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: "resp_test", status: "completed", output: [item] },
    },
  ];
  const encoded = new TextEncoder().encode(
    events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("")
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
      controller.close();
    },
  });
  const text = await restoreApplyPatchResponse(
    new Response(stream, { headers: { "content-type": "text/event-stream" } })
  ).text();
  const result = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(result.length, 4);
  assert.equal(text.includes(APPLY_PATCH_FUNCTION), false);
  assert.deepEqual(result[1].item.operation, operation);
  assert.equal(result[1].item.type, "apply_patch_call");
  assert.equal(result[2].item.call_id, item.call_id);
  assert.deepEqual(result[3].response.output, [result[2].item]);
  assert.deepEqual(
    result.map((event) => event.sequence_number),
    [0, 1, 2, 3]
  );
});

test("invalid upstream patch fails closed rather than publishing an invalid operation", async () => {
  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: APPLY_PATCH_FUNCTION,
      arguments: '{"operation":{"type":"run_command"}}',
    },
  };
  const text = await restoreApplyPatchResponse(
    new Response(`data: ${JSON.stringify(event)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  ).text();
  assert.match(text, /response.failed/);
  assert.doesNotMatch(text, /run_command/);
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
