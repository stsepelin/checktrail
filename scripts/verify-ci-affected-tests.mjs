import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { runRequiredTests } from "./required-test-evidence.mjs";
const plan = JSON.parse(process.env.CHECKTRAIL_CI_PLAN);
assert.equal(plan.mode, "affected");
assert.ok(
  Array.isArray(plan.sharedTestFiles) &&
    plan.sharedTestFiles.length >= 2 &&
    plan.sharedTestFiles.length <= 1000,
);
assert.equal(new Set(plan.sharedTestFiles).size, plan.sharedTestFiles.length);
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const files = await Promise.all(
  plan.sharedTestFiles.map(async (file) => {
    assert.match(file, /^dist\/test\/[a-z0-9-]+\.test\.js$/);
    const absolute = path.join(root, file);
    assert.ok((await lstat(absolute)).isFile());
    assert.equal(await realpath(absolute), absolute);
    return absolute;
  }),
);
const required = [
  {
    file: path.join(root, "dist/test/ci-impact.test.js"),
    name: "CI declared native inputs match every workflow controller profile matrix and imported fixture",
  },
  {
    file: path.join(root, "dist/test/gate-inventory.test.js"),
    name: "finite inventory audit preserves every original named native case without declaring implementation or quality acceptance",
  },
];
for (const row of required) assert.ok(files.includes(row.file));
const evidence = await runRequiredTests(required, {
  additionalFiles: files,
  timeoutMs: 600000,
});
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    scope:
      "Affected complete test files plus required CI and inventory controls",
    selectedFiles: plan.sharedTestFiles,
    evidence,
    fullRevisionVerification: false,
    nativeProfileQualificationClaimed: false,
    gateAComplete: false,
  }) + "\n",
);
process.exitCode = evidence.complete ? 0 : 1;
