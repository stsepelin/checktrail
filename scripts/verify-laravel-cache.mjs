import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { runRequiredProfiles } from "./required-test-evidence.mjs";
import {
  laravelCacheSelection,
  laravelCacheHarnessFiles,
  laravelCacheDigest,
  captureLaravelCacheInputs,
  observeLaravelCacheRuntime,
  requireLaravelCacheAccounting,
} from "./laravel-cache-runtime-evidence.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(process.argv.length, 2);
const profiles = JSON.parse(
  await readFile(path.join(root, "scripts/required-native-tests.json"), "utf8"),
);
for (const profile of laravelCacheSelection) {
  assert.ok(Array.isArray(profiles[profile]) && profiles[profile].length > 0);
  for (const row of profiles[profile]) {
    assert.ok(
      laravelCacheHarnessFiles.includes(row.file),
      "Laravel cache case is outside the declared harness",
    );
    row.file = path.join(root, row.file);
  }
}
assert.equal(
  laravelCacheSelection.reduce(
    (count, profile) => count + profiles[profile].length,
    0,
  ),
  9,
);
const inputSources = await captureLaravelCacheInputs(root);
const runtime = await observeLaravelCacheRuntime(root);
const engineRoot = path.join(root, "dist/src"),
  before = await captureCompiledEngine(engineRoot);
const evidence = await runRequiredProfiles(profiles, laravelCacheSelection, {
  timeoutMs: 300000,
  isolatedCaseWorkers: 1,
  onCaseProgress: (event) =>
    process.stderr.write(
      JSON.stringify({ profile: "laravel-cache-runtime", ...event }) + "\n",
    ),
});
requireLaravelCacheAccounting(evidence, profiles);
assert.deepEqual(
  await observeLaravelCacheRuntime(root),
  runtime,
  "Laravel cache runtime identity changed during acceptance",
);
assert.deepEqual(
  await captureLaravelCacheInputs(root),
  inputSources,
  "Laravel cache harness bytes changed during acceptance",
);
const compiledEngine = requireUnchangedCompiledEngine(
  before,
  await captureCompiledEngine(engineRoot),
);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "laravel-cache-runtime-v1",
    ...evidence,
    runtime,
    inputSources,
    harnessSha256: laravelCacheDigest(JSON.stringify(inputSources)),
    harnessInputsUnchanged: true,
    compiledEngine,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    gateAComplete: false,
  }) + "\n",
);
