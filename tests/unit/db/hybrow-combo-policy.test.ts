import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrow-combo-policy-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "hybrow-test-only-key-secret";
const core = await import("../../../src/lib/db/core.ts");
const keys = await import("../../../src/lib/db/apiKeys.ts");
const { comboTargetPassesKeyModelPolicy } =
  await import("../../../src/sse/handlers/chat/comboTargetKeyPolicy.ts");

test.after(() => {
  keys.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("primary combo grants keep deny rules and do not contaminate direct-call permission cache", async (t) => {
  const previousRole = process.env.OMNIROUTE_DEPLOYMENT_ROLE;
  process.env.OMNIROUTE_DEPLOYMENT_ROLE = "primary";
  t.after(() => {
    if (previousRole === undefined) delete process.env.OMNIROUTE_DEPLOYMENT_ROLE;
    else process.env.OMNIROUTE_DEPLOYMENT_ROLE = previousRole;
  });
  const created = await keys.createApiKey("combo-only", "hybrow-tests");
  await keys.updateApiKeyPermissions(created.id, {
    modelAccessMode: "restricted",
    allowedModels: ["executor"],
    allowedCombos: ["executor"],
    blockedModels: ["openai/blocked"],
  });
  const info = await keys.getApiKeyMetadata(created.key);
  const allowed = (targetModelStr: string) =>
    comboTargetPassesKeyModelPolicy({
      apiKey: created.key,
      apiKeyInfo: info,
      requestedModelStr: "executor",
      targetModelStr,
      isModelAllowedForKey: keys.isModelAllowedForKey,
    });
  assert.equal(await keys.isModelAllowedForKey(created.key, "openai/allowed"), false);
  assert.equal(await allowed("openai/allowed"), true);
  assert.equal(await allowed("openai/blocked"), false);
  assert.equal(await keys.isModelAllowedForKey(created.key, "openai/allowed"), false);
});
