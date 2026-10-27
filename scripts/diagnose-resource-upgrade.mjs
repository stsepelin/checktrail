// Diagnostic-only exact callback reproduction. Never merge this controller.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const profiles = JSON.parse(
  await readFile(
    new URL("./required-native-tests.json", import.meta.url),
    "utf8",
  ),
);
const requirements = profiles["resource-release-readiness"]
  .filter(
    (item) => item.name === "resource-release-readiness near-miss acceptance",
  )
  .map((item) => ({ ...item, file: path.join(root, item.file) }));
assert.equal(requirements.length, 1);
const before = await captureCompiledEngine(path.join(root, "dist/src"));
const result = await runRequiredTests(requirements, {
  timeoutMs: 600000,
  isolatedCaseWorkers: 1,
  onCaseProgress: (event) => process.stderr.write(JSON.stringify(event) + "\n"),
});
requireUnchangedCompiledEngine(
  before,
  await captureCompiledEngine(path.join(root, "dist/src")),
);
process.stdout.write(
  JSON.stringify({
    profile: "diagnostic-resource-upgrade-near-miss-only",
    ...result,
    compiledEngineSha256: before.treeSha256,
    resourceFullProfileQualified: false,
    selectedRuntimeMatrixQualified: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
process.exitCode = result.complete ? 0 : 1;
