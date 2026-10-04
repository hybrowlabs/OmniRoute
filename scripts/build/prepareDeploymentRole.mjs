#!/usr/bin/env node
/** Export a committed compatibility candidate without equalizing live role policies. */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

const [role, commit, destination, ...extra] = process.argv.slice(2);
if (
  !["primary", "replica"].includes(role) ||
  !/^[a-f0-9]{40}$/.test(commit || "") ||
  !destination ||
  extra.length
) {
  throw new Error(
    "Usage: node scripts/build/prepareDeploymentRole.mjs <primary|replica> <full-commit-sha> <new-directory>"
  );
}
const vendor = "8ec44b71943fb1a52faac35b352d7841e2a35882";
const baseline = "4b573d1ff763e2284ac06e5e62c03b34b95228f6";
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", ["-C", root, ...args]);
git("merge-base", "--is-ancestor", baseline, commit);
const target = path.resolve(destination);
await fs.mkdir(path.dirname(target), { recursive: true });
// Deliberately refuse any existing destination, including prior build outputs.
await fs.mkdir(target);
const archive = spawn("git", ["-C", root, "archive", commit], {
  stdio: ["ignore", "pipe", "inherit"],
});
const extract = spawn("tar", ["-x", "-C", target], { stdio: ["pipe", "inherit", "inherit"] });
const archiveExit = once(archive, "close");
const extractExit = once(extract, "close");
await pipeline(archive.stdout, extract.stdin);
const [[archiveCode], [extractCode]] = await Promise.all([archiveExit, extractExit]);
if (archiveCode !== 0 || extractCode !== 0) throw new Error("Source archive extraction failed");

const restoredPaths =
  role === "primary"
    ? ["src/lib/db/providers.ts", "src/lib/db/readCache.ts", "scripts/build/assembleStandalone.mjs"]
    : ["src/lib/db/apiKeys.ts", "src/sse/handlers/chat.ts"];
for (const file of restoredPaths) {
  await fs.writeFile(path.join(target, file), git("show", `${vendor}:${file}`));
}
const removedPaths =
  role === "primary"
    ? [
        "src/lib/db/providers/connectionCooldownSync.ts",
        "tests/unit/db/connectionCooldownSync.test.ts",
        "tests/unit/build/assembleStandalone.ioredis.test.ts",
      ]
    : [];
for (const file of removedPaths) await fs.unlink(path.join(target, file));

const attestedPaths = [
  "package.json",
  "package-lock.json",
  "open-sse/package.json",
  "packages/browser-pool/package.json",
  "src/lib/db/apiKeys.ts",
  "src/sse/handlers/chat.ts",
  "src/lib/db/providers.ts",
  "src/lib/db/readCache.ts",
  "scripts/build/assembleStandalone.mjs",
  "src/shared/constants/claudeCodeClient.ts",
  ...(role === "replica" ? ["src/lib/db/providers/connectionCooldownSync.ts"] : []),
];
const hashes = {};
for (const file of attestedPaths) {
  hashes[file] = createHash("sha256")
    .update(await fs.readFile(path.join(target, file)))
    .digest("hex");
}
const provenance = {
  sourceCommit: commit,
  role,
  reconstructedBaseline: baseline,
  vendorArchiveCommit: vendor,
  restoredPaths,
  removedPaths,
  sha256: hashes,
  note: "Role-specific source export, not proof of a historical image Git revision or a successful build.",
};
await fs.writeFile(
  path.join(target, "deployment-role.json"),
  `${JSON.stringify(provenance, null, 2)}\n`
);
console.log(
  JSON.stringify({
    role,
    sourceCommit: commit,
    destination: target,
    provenance: "deployment-role.json",
  })
);
