import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-280-"));
process.env.DATA_DIR = dataDir;
// DB-backed imports must happen after DATA_DIR is isolated, before module initialization.
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const codexCfg = await import("../../open-sse/config/codexClient.ts");
const { normalizeThinkingForModel } = await import("../../src/shared/constants/modelSpecs.ts");
const { normalizeClaudeAdaptiveThinking } =
  await import("../../open-sse/services/claudeAdaptiveThinking.ts");
const { modelHasNativeContext1m } =
  await import("../../open-sse/config/claudeCodeCompatibleIdentity.ts");
const { modelSupportsContext1mBeta } = await import("../../open-sse/config/context1m.ts");
const { getUnsupportedParams } = await import("../../open-sse/config/providerRegistry.ts");

test.after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

interface WireBody {
  model: string;
  system: Array<{ text: string }>;
  messages: Array<{ role: string; content: unknown }>;
  metadata: { user_id: string };
  safeguards?: unknown;
}

async function captureRequest(model: string, body: Record<string, unknown>, beta = "") {
  const originalFetch = globalThis.fetch;
  let captured: { headers: Headers; body: WireBody } | undefined;
  globalThis.fetch = async (_url, init = {}) => {
    captured = { headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await new DefaultExecutor("claude").execute({
      model,
      body: { model, max_tokens: 64, ...body },
      stream: false,
      credentials: {
        accessToken: "offline-oauth-token",
        providerSpecificData: {
          cliUserID: "a".repeat(64),
          accountUUID: "00000000-0000-4000-8000-000000000001",
        },
      },
      clientHeaders: { "x-app": "cli", "anthropic-beta": beta },
    });
    assert.ok(captured, "the executor must dispatch a serialized request");
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("native Opus 5.5 dispatch emits the coupled captured client, SDK and signed billing contract", async () => {
  const { headers, body } = await captureRequest("claude-opus-5-5", {
    messages: [{ role: "user", content: "offline request contract" }],
  });
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(headers.get("user-agent"), "claude-cli/2.1.280 (external, cli)");
  assert.equal(headers.get("x-stainless-package-version"), "0.112.1");
  assert.equal(headers.get("x-stainless-runtime-version"), "v26.3.0");
  assert.match(
    body.system[0].text,
    /^x-anthropic-billing-header: cc_version=2\.1\.280\.1e2; cc_entrypoint=cli; cch=[0-9a-f]{5};$/
  );
  const userId = JSON.parse(body.metadata.user_id);
  assert.equal(headers.get("x-claude-code-session-id"), userId.session_id);
  assert.equal(headers.get("anthropic-beta")?.includes("skills-2025-10-02"), false);
});

test("Fable dispatch retains negotiated thinking and safeguards betas and relocates a leading effort directive", async () => {
  const directive = { role: "system", content: [], output_config: { effort: "medium" } };
  const betas = [
    "thinking-binding-controls-2026-08-01",
    "thinking-display-updates-2026-08-18",
    "dangerous-tool-use-2026-09-03",
    "afk-mode-2026-01-31",
  ];
  const { headers, body } = await captureRequest(
    "claude-fable-5-1",
    {
      system: "Existing system prompt",
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
      safeguards: { enabled: true },
      messages: [
        { role: "system", content: "Initial output style" },
        directive,
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "system", content: "Later instruction" },
        { role: "user", content: "continue" },
      ],
    },
    [...betas, "skills-2025-10-02", "unknown-beta"].join(",")
  );
  const outboundBetas = headers.get("anthropic-beta")!.split(",");
  for (const beta of [
    ...betas,
    "mid-conversation-system-2026-04-07",
    "mid-conversation-output-config-2026-07-01",
  ]) {
    assert.ok(outboundBetas.includes(beta), beta);
  }
  assert.equal(outboundBetas.includes("skills-2025-10-02"), false);
  assert.equal(outboundBetas.includes("unknown-beta"), false);
  assert.equal(outboundBetas.includes("context-1m-2025-08-07"), false);
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(body.messages[1], directive);
  assert.equal(body.messages[3].content, "Later instruction");
  assert.equal(body.system.at(-1)?.text, "Initial output style");
  assert.deepEqual(body.safeguards, { enabled: true });
});

test("Skills negotiation is preserved when the dispatched request has a code execution tool", async () => {
  const { headers } = await captureRequest(
    "claude-opus-5-5",
    {
      tools: [{ type: "code_execution_20250825", name: "code_execution" }],
      messages: [{ role: "user", content: "hello" }],
    },
    "skills-2025-10-02"
  );
  assert.ok(headers.get("anthropic-beta")!.split(",").includes("skills-2025-10-02"));
});

test("Fable 5.1 accepts neither forced tools nor disabled/manual thinking and does not inherit Fable 5 beta eligibility", () => {
  const model = "claude-fable-5-1";
  const tools = [{ name: "lookup", input_schema: { type: "object" } }];
  const disabled = normalizeThinkingForModel(
    { tools, tool_choice: { type: "tool", name: "lookup" }, thinking: { type: "disabled" } },
    model
  );
  assert.equal("tool_choice" in disabled, false);
  assert.equal("thinking" in disabled, false);
  assert.deepEqual(disabled.tools, tools);
  const manual = normalizeClaudeAdaptiveThinking(
    { thinking: { type: "enabled", budget_tokens: 4000 } },
    model
  );
  assert.deepEqual(manual.thinking, { type: "adaptive" });
  assert.equal(modelHasNativeContext1m(model), true);
  assert.equal(modelSupportsContext1mBeta(model), false);
  assert.equal(modelSupportsContext1mBeta("claude-fable-5-high"), true);
  const unsupported = getUnsupportedParams("claude", model);
  for (const param of ["temperature", "top_p", "top_k"]) assert.ok(unsupported.includes(param));
  const older = { tools, tool_choice: { type: "tool", name: "lookup" } };
  assert.equal(normalizeThinkingForModel(older, "claude-fable-5"), older);
});

test("Codex client is pinned to the captured 0.149.0 release", () => {
  assert.equal(codexCfg.getCodexClientVersion(), "0.149.0");
  assert.equal(codexCfg.getCodexUserAgent(), "codex-cli/0.149.0 (Windows 10.0.26200; x64)");
  assert.equal(codexCfg.getCodexDefaultHeaders().Version, "0.149.0");
  assert.equal(codexCfg.getCodexCliRsHeaders()["User-Agent"], "codex_cli_rs/0.149.0");
});
