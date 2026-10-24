import process from "node:process";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import {
  runRequiredTests,
  runRequiredProfiles,
} from "./required-test-evidence.mjs";
import {
  lifecycleHarnessFiles,
  lifecycleFoundationSelection,
  lifecycleDigest,
  observeLifecycleRuntime,
} from "./lifecycle-runtime-evidence.mjs";
assert.ok(process.argv.length === 2 || process.argv.length === 3);
const slot =
  process.argv[2] ?? process.env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT ?? null;
if (slot !== null) {
  assert.ok(
    !process.env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT ||
      process.env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT === slot,
    "Conflicting lifecycle runtime selection",
  );
  process.env.CHECKTRAIL_LIFECYCLE_RUNTIME_SLOT = slot;
}
const profiles = JSON.parse(
  await readFile(
    new URL("./required-native-tests.json", import.meta.url),
    "utf8",
  ),
);
const requirements = profiles["lifecycle-platforms"];
const inventory = JSON.parse(
  await readFile(
    new URL("../docs/gate-a-profiles.v1.json", import.meta.url),
    "utf8",
  ),
);
const selection = inventory.extensionProfiles.find(
  (profile) => profile.id === "lifecycle-platforms",
);
assert.deepEqual(
  requirements,
  selection.acceptanceCases.map((item) => ({
    file: selection.acceptanceFile,
    name: item.name,
  })),
);
assert.equal(requirements.length, 9);
const runtime = await observeLifecycleRuntime(inventory, slot);
const repository = fileURLToPath(new URL("../", import.meta.url));
const captureHarness = () =>
  Promise.all(
    lifecycleHarnessFiles.map(async (file) => [
      file,
      lifecycleDigest(await readFile(path.join(repository, file))),
    ]),
  );
const foundationSelection = lifecycleFoundationSelection();
const foundationRequirements = Object.fromEntries(
  foundationSelection.map((profile) => {
    assert.ok(
      Array.isArray(profiles[profile]) && profiles[profile].length > 0,
      "Missing lifecycle platform foundation",
    );
    return [
      profile,
      profiles[profile].map((row) => {
        assert.ok(
          lifecycleHarnessFiles.includes(row.file),
          "Foundation file is outside the declared harness",
        );
        return { ...row, file: path.join(repository, row.file) };
      }),
    ];
  }),
);
const inputSources = await captureHarness();
const root = new URL("../dist/src/", import.meta.url),
  before = await captureCompiledEngine(root);
const evidence = await runRequiredTests(
  requirements.map((row) => ({
    ...row,
    file: path.join(repository, row.file),
  })),
  {
    timeoutMs: process.platform === "win32" ? 600000 : 300000,
    isolatedCaseWorkers: 1,
    onCaseProgress: (event) =>
      process.stderr.write(
        JSON.stringify({ profile: "lifecycle-platforms", ...event }) + "\n",
      ),
  },
);
const foundation = await runRequiredProfiles(
  foundationRequirements,
  foundationSelection,
  {
    timeoutMs: process.platform === "win32" ? 600000 : 300000,
    isolatedCaseWorkers: 1,
    onCaseProgress: (event) =>
      process.stderr.write(
        JSON.stringify({ profile: "lifecycle-platform-foundation", ...event }) +
          "\n",
      ),
  },
);
const complete = evidence.complete && foundation.complete;
assert.deepEqual(
  await observeLifecycleRuntime(inventory, slot),
  runtime,
  "Lifecycle runtime identity changed during acceptance",
);
assert.deepEqual(
  await captureHarness(),
  inputSources,
  "Lifecycle harness bytes changed during acceptance",
);
const compiledEngine = requireUnchangedCompiledEngine(
  before,
  await captureCompiledEngine(root),
);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "lifecycle-platforms-runtime-v1",
    ...evidence,
    complete,
    completionScope: "whole-profile-and-selected-platform-foundation",
    problems: [
      ...evidence.problems,
      ...foundation.problems.map((problem) => ({
        ...problem,
        profile: "selected-platform-foundation",
      })),
    ],
    foundation,
    compiledEngine,
    installed: process.env.CHECKTRAIL_LIFECYCLE_INSTALLED === "1",
    environment: {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    },
    runtime,
    selectedRuntime: runtime.selectedRuntime,
    inputSources,
    harnessSha256: lifecycleDigest(JSON.stringify(inputSources)),
    harnessInputsUnchanged: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    gateAComplete: false,
  }) + "\n",
);
process.exitCode = complete ? 0 : 1;
