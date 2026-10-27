// Explicit operator preparation; no baseline command or model is executed.
// --offline-dependencies affects npm only; archive acquisition uses the pinned URL.
import assert from "node:assert/strict";
import process from "node:process";
import { prepareReleaseTools } from "./release-readiness-tools.mjs";
assert.ok(
  process.argv.length === 2 ||
    (process.argv.length === 3 && process.argv[2] === "--offline-dependencies"),
);
const result = await prepareReleaseTools({
  offlineDependencies: process.argv[2] === "--offline-dependencies",
});
process.stdout.write(
  JSON.stringify({
    ...result.observation,
    baselineExecuted: false,
    lifecycleScriptsExecuted: false,
  }) + "\n",
);
