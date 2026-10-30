// Operator-only synthetic readiness. No inference, review trial or publication.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { observeLifecycleRuntime as observeResourceRuntime } from "./lifecycle-runtime-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { resourceReleaseHarnessFiles } from "./resource-release-evidence.mjs";
import { observeReleaseTools } from "./release-readiness-tools.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const requirements = JSON.parse(
  await readFile(
    new URL("./required-native-tests.json", import.meta.url),
    "utf8",
  ),
)["resource-release-readiness"];
assert.equal(requirements.length, 9);
const inventory = JSON.parse(
  await readFile(
    new URL("../docs/gate-a-profiles.v1.json", import.meta.url),
    "utf8",
  ),
);
assert.ok(process.argv.length === 2 || process.argv.length === 3);
const slot = process.argv[2] ?? null;
const runtime = await observeResourceRuntime(inventory, slot);
const selection = inventory.extensionProfiles.find(
  (profile) => profile.id === "resource-release-readiness",
);
assert.deepEqual(
  requirements,
  selection.acceptanceCases.map((item) => ({
    file: selection.acceptanceFile,
    name: item.name,
  })),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const captureHarness = () =>
  Promise.all(
    resourceReleaseHarnessFiles.map(async (file) => [
      file,
      hash(await readFile(path.join(root, file))),
    ]),
  );
const inputSources = await captureHarness(),
  harnessSha256 = hash(JSON.stringify(inputSources));
const before = await captureCompiledEngine(path.join(root, "dist/src")),
  tools = await observeReleaseTools();
const source = await runRequiredTests(
  requirements.map((item) => ({ ...item, file: path.join(root, item.file) })),
  {
    timeoutMs: 600000,
    isolatedCaseWorkers: 1,
    onCaseProgress: (event) =>
      process.stderr.write(
        JSON.stringify({ profile: "resource-release-readiness", ...event }) +
          "\n",
      ),
  },
);
assert.equal(source.complete, true, JSON.stringify(source.problems));
assert.equal(source.passed, 9);
assert.equal(source.ledger.truncated, false);
const fixture = await import(
  new URL("../dist/test/resource-release-fixture.js", import.meta.url)
);
const cleanups = [];
let installed;
try {
  installed = await fixture.resourceWholeInstalled({
    after: (callback) => cleanups.push(callback),
  });
  assert.equal(installed.profile.complete, true);
  assert.equal(installed.profile.passed, 9);
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
requireUnchangedCompiledEngine(
  before,
  await captureCompiledEngine(path.join(root, "dist/src")),
);
assert.deepEqual(await observeReleaseTools(undefined, tools), tools);
assert.deepEqual(await observeResourceRuntime(inventory, slot), runtime);
assert.deepEqual(
  await captureHarness(),
  inputSources,
  "Resource harness changed during acceptance",
);
assert.equal(
  installed.harnessSha256,
  harnessSha256,
  "Fresh resource harness differs from source",
);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "resource-release-readiness",
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    nodeExecutableSha256: createHash("sha256")
      .update(
        await readFile(
          await import("node:fs/promises").then((api) =>
            api.realpath(process.execPath),
          ),
        ),
      )
      .digest("hex"),
    runtime,
    harnessSha256,
    inputSources,
    harnessInputsUnchanged: true,
    selectedRuntimeValidated: runtime.selectedRuntime !== null,
    compiledEngineSha256: before.treeSha256,
    source,
    installed,
    selectedRuntimeMatrixQualified: false,
    completeArtifactClosure: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
