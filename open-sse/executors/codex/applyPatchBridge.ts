import { z } from "zod";
import { buildErrorBody } from "../../utils/error.ts";

type RecordValue = Record<string, unknown>;
export const APPLY_PATCH_FUNCTION = "__omniroute_apply_patch";
const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_file"), path: z.string(), diff: z.string() }),
  z.object({ type: z.literal("update_file"), path: z.string(), diff: z.string() }),
  z.object({ type: z.literal("delete_file"), path: z.string() }),
]);
const argumentsSchema = z.object({ operation: operationSchema });
const record = (value: unknown): RecordValue | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;

export function usesNativeApplyPatch(body: unknown): boolean {
  const root = record(body);
  return (
    Array.isArray(root?.tools) && root.tools.some((tool) => record(tool)?.type === "apply_patch")
  );
}

// Codex's private Responses endpoint rejects the public native apply_patch type.
// Bridge only that type; custom/freeform tools named apply_patch are unrelated.
export function bridgeApplyPatchRequest(body: RecordValue): void {
  if (!usesNativeApplyPatch(body)) return;
  const tools = body.tools as RecordValue[];
  if (tools.some((tool) => tool.name === APPLY_PATCH_FUNCTION)) {
    throw new Error("Native apply_patch conflicts with reserved router function name");
  }
  body.tools = tools.map((tool) =>
    tool.type !== "apply_patch"
      ? tool
      : {
          type: "function",
          name: APPLY_PATCH_FUNCTION,
          description:
            "Apply one file operation. create_file diff contains added lines prefixed with +; update_file diff uses apply_patch hunks with @@ and context/add/remove lines, without Begin/End Patch wrappers; delete_file needs only path. The client executes this operation.",
          parameters: {
            type: "object",
            properties: {
              operation: {
                anyOf: [
                  ...["create_file", "update_file"].map((type) => ({
                    type: "object",
                    properties: {
                      type: { type: "string", enum: [type] },
                      path: { type: "string" },
                      diff: { type: "string" },
                    },
                    required: ["type", "path", "diff"],
                    additionalProperties: false,
                  })),
                  {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["delete_file"] },
                      path: { type: "string" },
                    },
                    required: ["type", "path"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            required: ["operation"],
            additionalProperties: false,
          },
          strict: true,
        }
  );
  const choice = record(body.tool_choice);
  const mapChoice = (value: unknown) =>
    record(value)?.type === "apply_patch"
      ? { type: "function", name: APPLY_PATCH_FUNCTION }
      : value;
  if (choice?.type === "allowed_tools" && Array.isArray(choice.tools))
    choice.tools = choice.tools.map(mapChoice);
  else body.tool_choice = mapChoice(body.tool_choice);
  if (Array.isArray(body.input))
    body.input = body.input.map((value) => {
      const item = record(value);
      if (item?.type === "apply_patch_call")
        return {
          type: "function_call",
          call_id: item.call_id,
          name: APPLY_PATCH_FUNCTION,
          arguments: JSON.stringify({ operation: item.operation }),
          status: item.status,
        };
      if (item?.type === "apply_patch_call_output")
        return {
          type: "function_call_output",
          call_id: item.call_id,
          output: JSON.stringify({ status: item.status, output: item.output ?? "" }),
        };
      return value;
    });
}

function restoreItem(value: unknown): unknown {
  const item = record(value);
  if (item?.type !== "function_call" || item.name !== APPLY_PATCH_FUNCTION) return value;
  const args = argumentsSchema.parse(JSON.parse(String(item.arguments)));
  return {
    id: item.id,
    type: "apply_patch_call",
    call_id: item.call_id,
    status: item.status ?? "completed",
    operation: args.operation,
  };
}

export function restoreApplyPatchResponse(response: Response): Response {
  // Codex is SSE-first but can omit Content-Type on successful responses.
  const contentType = response.headers.get("content-type");
  if (!response.ok || !response.body || (contentType && !contentType.includes("text/event-stream")))
    return response;
  const patchIds = new Set<unknown>();
  let sequence = 0;
  let failed = false;
  let buffer = "";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const emit = (event: RecordValue, controller: TransformStreamDefaultController<Uint8Array>) => {
    controller.enqueue(
      encoder.encode(
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`
      )
    );
  };
  const frame = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (failed) return;
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      controller.enqueue(encoder.encode(text + "\n\n"));
      return;
    }
    try {
      const event = JSON.parse(data) as RecordValue;
      const item = record(event.item);
      if (
        event.type === "response.output_item.added" &&
        item?.type === "function_call" &&
        item.name === APPLY_PATCH_FUNCTION
      ) {
        patchIds.add(item.id);
        return;
      }
      if (
        String(event.type).startsWith("response.function_call_arguments.") &&
        patchIds.has(event.item_id)
      )
        return;
      if (
        event.type === "response.output_item.done" &&
        item?.type === "function_call" &&
        item.name === APPLY_PATCH_FUNCTION
      ) {
        const restored = restoreItem(item);
        emit({ ...event, type: "response.output_item.added", item: restored }, controller);
        emit({ ...event, item: restored }, controller);
        return;
      }
      const result = record(event.response);
      if (result && Array.isArray(result.output)) result.output = result.output.map(restoreItem);
      emit(event, controller);
    } catch {
      failed = true;
      emit(
        {
          type: "response.failed",
          response: {
            id: "resp_apply_patch_bridge_failed",
            status: "failed",
            ...buildErrorBody(502, "Invalid apply_patch operation returned by upstream"),
          },
        },
        controller
      );
    }
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, match.index), controller);
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (buffer.length > 8 * 1024 * 1024)
        throw new Error("Upstream apply_patch event exceeds size limit");
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) frame(buffer, controller);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (!contentType) headers.set("content-type", "text/event-stream");
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
