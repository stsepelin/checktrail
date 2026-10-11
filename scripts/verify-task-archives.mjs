import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { attemptOutputCodeIdentity } from "./attempt-output-evidence.mjs";
import { taskArchiveRequirements } from "./task-archive-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requirements = await taskArchiveRequirements(repository);
const inputs = [
  ...requirements.map((x) => path.relative(repository, x.file)),
  "dist/test/helpers.js",
  "dist/test/tasks-wire-fixture.js",
  "scripts/attempt-output-evidence.mjs",
  "scripts/required-test-evidence.mjs",
  "scripts/verify-task-archives.mjs",
  "scripts/task-archive-evidence.mjs",
  "scripts/required-native-tests.json",
];
const identity = async () =>
  hash(
    JSON.stringify(
      await Promise.all(
        inputs.map(async (file) => [
          file,
          hash(await readFile(path.join(repository, file))),
        ]),
      ),
    ),
  );
const [code, harness, executable] = await Promise.all([
  attemptOutputCodeIdentity(repository),
  identity(),
  readFile(process.execPath).then(hash),
]);
const profile = await runRequiredTests(requirements, {
  timeoutMs: 300000,
  isolatedCaseWorkers: 1,
});
assert.equal(
  profile.complete,
  true,
  "Source durable task archive controls failed: " +
    JSON.stringify(profile.problems),
);
assert.equal(profile.required, requirements.length);
assert.equal(profile.ledger.truncated, false);
assert.equal(profile.ledger.cases.length, requirements.length);
assert.ok(profile.ledger.cases.every((x) => x.outcome === "passed"));
assert.equal(code, await attemptOutputCodeIdentity(repository));
assert.equal(harness, await identity());
assert.equal(executable, hash(await readFile(process.execPath)));
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "durable-task-report-archives-v1",
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    nodeExecutableSha256: executable,
    compiledCodeSha256: code,
    harnessSha256: harness,
    attemptArchivesGateAcceptanceComplete: false,
    selectedDurableTaskReportRetention: true,
    completeDurableAttemptArchiveAcceptance: false,
    nativeWindowsArchiveAcceptance: false,
    wholeNativeCallFamilyMigrated: false,
    inferenceExecuted: false,
    fieldEvaluationExecuted: false,
    profileEvidence: profile,
  }) + "\n",
);
