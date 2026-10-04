// tests/unit/build/assembleStandalone.ioredis.test.ts
//
// Regression test for the ioredis-invisible-to-standalone-tracer bug: ioredis
// (and every other Redis consumer relying on it: storeFactory.ts,
// redisQuotaStore.ts, the shared provider-connection-cooldown coordinator)
// loads ioredis via a deliberately-dynamic `await import("ioredis")` to dodge
// esbuild's static-import hoisting in the MCP bundle. That makes it invisible
// to Next.js's standalone output-file tracer, so a built runtime image shipped
// only ioredis's package.json — never its real code — and every real Redis
// operation threw MODULE_NOT_FOUND at first use. Confirmed live on the
// deployed production image: `node_modules/ioredis/` contained nothing but
// package.json, and `require.resolve("ioredis")` failed.
//
// This exercises the real fix (an EXTRA_MODULE_ENTRIES entry for ioredis +
// its full flat dependency list, following the exact established pattern
// already used for wreq-js/undici/sqlite-vec's identical class of bug) via
// the actual exported, injectable `syncStandaloneExtraModules` function
// against a real temp filesystem — not a mock, not an array-contents check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { syncStandaloneExtraModules } from "../../../scripts/build/assembleStandalone.mjs";

// The exact flat dependency set a real `npm install ioredis@5.10.1` produces
// at the project's top-level node_modules (verified directly: a fresh
// `npm install ioredis@5.10.1 --prefix <tmp>` and `ls node_modules` in a
// clean node:26 container). ioredis resolves every one of these via a real
// (non-dynamic) `require(...)`, so each needs its own explicit copy — the
// project's existing entries (wreq-js, undici, pino-pretty, etc.) establish
// that EXTRA_MODULE_ENTRIES never recurses into a package's own
// dependencies; it only copies exactly the src path given.
const IOREDIS_PACKAGES = [
  "ioredis",
  path.join("@ioredis", "commands"),
  "cluster-key-slot",
  "debug",
  "denque",
  "lodash.defaults",
  "lodash.isarguments",
  "ms",
  "redis-errors",
  "redis-parser",
  "standard-as-callback",
];

async function makeFakeProjectRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-ioredis-test-"));
  for (const pkg of IOREDIS_PACKAGES) {
    const pkgDir = path.join(root, "node_modules", pkg);
    await fs.mkdir(pkgDir, { recursive: true });
    // A minimal but real, importable ESM module per package — enough to
    // prove import() actually resolves and executes the copied file
    // post-sync, not just that a directory with the right name exists.
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: pkg, version: "0.0.0-test", type: "module", main: "index.mjs" })
    );
    await fs.writeFile(
      path.join(pkgDir, "index.mjs"),
      `export const from = ${JSON.stringify(pkg)};\n`
    );
  }
  return root;
}

test("syncStandaloneExtraModules copies ioredis and its full dependency set into the standalone output", async () => {
  const projectRoot = await makeFakeProjectRoot();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-ioredis-out-"));
  try {
    const changed = await syncStandaloneExtraModules(projectRoot, fs, { log() {} }, outDir);
    assert.equal(changed, true, "expected at least one module to be synced");

    for (const pkg of IOREDIS_PACKAGES) {
      const destPkgJson = path.join(outDir, "node_modules", pkg, "package.json");
      const destIndex = path.join(outDir, "node_modules", pkg, "index.mjs");
      await assert.doesNotReject(
        fs.access(destPkgJson),
        `expected ${pkg}/package.json to exist in the standalone output`
      );
      await assert.doesNotReject(
        fs.access(destIndex),
        `expected ${pkg}/index.mjs to exist in the standalone output`
      );

      // The actual regression this guards against: not just "a file with the
      // right name exists" but "the copied module is genuinely importable"
      // (mirrors what actually failed in production: import() threw
      // MODULE_NOT_FOUND because only package.json had been copied, no code).
      const imported = await import(pathToFileURL(destIndex).href);
      assert.equal(imported.from, pkg);
    }
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("syncStandaloneExtraModules is a no-op when ioredis is absent from the source tree (non-Redis builds)", async () => {
  // EXTRA_MODULE_ENTRIES already skips any entry whose src path doesn't
  // exist (see `if (!(await exists(sourcePath))) continue;`). This confirms
  // the new ioredis entries don't regress that behavior for a project root
  // that never installed ioredis at all.
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-no-ioredis-"));
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-no-ioredis-out-"));
  try {
    await syncStandaloneExtraModules(projectRoot, fs, { log() {} }, outDir);
    await assert.rejects(
      fs.access(path.join(outDir, "node_modules", "ioredis")),
      "ioredis dest should not be created when the source package is absent"
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
