// Reconcile one original build observation. This never claims full qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  identifyFile,
  summarizeReports,
  validateInputs,
} from "./qualify-binutils-producer.mjs";
import {
  validateRetentionMessage,
  reconcileRetentionLog,
} from "./producer-qualification/binutils-retention-observer.mjs";
const directory = fileURLToPath(
  new URL("producer-qualification/", import.meta.url),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function validateBuildObservation(
  receipt,
  recipe,
  expected,
  controllerExit,
) {
  // The producer intentionally exits2 until its distinct qualification work closes.
  assert.equal(controllerExit, 2, "Unexpected producer controller exit");
  assert.equal(receipt.state, "build-completed-qualification-incomplete");
  assert.equal(receipt.profile, recipe.profile);
  assert.equal(receipt.recipeSha256, expected.recipeSha256);
  assert.equal(receipt.controllerSha256, expected.controllerSha256);
  assert.equal(receipt.image, recipe.image);
  assert.equal(receipt.platform, recipe.platform);
  assert.equal(receipt.pinnedInputs, recipe.files.length);
  assert.deepEqual(receipt.command, recipe.command);
  assert.equal(receipt.buildExecuted, true);
  assert.deepEqual(receipt.originalBuild, {
    invoked: true,
    exitCode: 0,
    commandCompleted: true,
    wrapperExitCode: 0,
  });
  const execution = receipt.executionObserver;
  assert.deepEqual(
    [
      execution.exitCode,
      execution.signal,
      execution.error,
      execution.reason,
      execution.stopError,
    ],
    [0, null, null, null, null],
    "Original foreground execution was incomplete",
  );
  assert.ok(
    Number.isSafeInteger(execution.retainedBytes) &&
      execution.retainedBytes >= 0 &&
      execution.retainedBytes <= recipe.limits.logByteLimit,
  );
  assert.ok(["absent", "removed"].includes(receipt.cleanup.state));
  const observer = receipt.retentionObserver;
  assert.equal(observer.state, "completed");
  assert.equal(observer.independentImage, recipe.image);
  assert.equal(observer.readOnly, true);
  assert.equal(observer.network, "none");
  assert.equal(observer.capability, "DAC_READ_SEARCH");
  assert.equal(observer.nativeFilesystemQuotaEnforced, false);
  assert.deepEqual(observer.terminal, { exitCode: 0, signal: null });
  assert.ok(Number.isSafeInteger(observer.samples) && observer.samples > 0);
  validateRetentionMessage(observer.lastSample, observer.samples);
  assert.equal(receipt.retainedWorkBytes, observer.lastSample.bytes);
  assert.ok(receipt.retainedWorkBytes <= recipe.limits.workByteLimit);
  assert.ok(
    Number.isSafeInteger(observer.retainedLogBytes) &&
      observer.retainedLogBytes > 0 &&
      observer.retainedLogBytes <= 16 * 1024 ** 2,
  );
  assert.equal(observer.log.bytes, observer.retainedLogBytes);
  assert.match(observer.log.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(
    ["absent", "removed"].includes(receipt.retentionObserverCleanup.state),
  );

  assert.equal(receipt.runtime.platform, "linux");
  assert.equal(receipt.runtime.architecture, "x64");
  assert.equal(receipt.runtime.kernelMachine, "x86_64");
  assert.match(receipt.runtime.dockerArchitecture, /^(amd64|x86_64)$/u);
  assert.ok(
    ["reported", "failed", "unavailable"].includes(receipt.testEvidence.state),
  );
  assert.equal(receipt.testEvidence.minimumSourceObligationsSatisfied, true);
  assert.equal(
    receipt.testEvidence.completeConfigurationInventoryAssessed,
    false,
  );
  assert.equal(
    receipt.buildCompletion.state,
    "build-completed-qualification-incomplete",
  );
  assert.equal(
    receipt.buildCompletion.testEvidenceState,
    receipt.testEvidence.state,
  );
  assert.equal(receipt.buildCompletion.qualificationComplete, false);
  assert.ok(
    receipt.outputs.files.some(
      (row) => row.file.endsWith(".deb") && row.bytes > 0,
    ),
  );
  for (const key of [
    "qualificationComplete",
    "fullCompilerSdkBootstrapClosureVerified",
    "completeOriginalNoticeClosureVerified",
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    assert.equal(receipt[key], false);
  return {
    schemaVersion: 1,
    state: "original-package-build-completed",
    originalCommandExitCode: receipt.originalBuild.exitCode,
    originalTestEvidenceState: receipt.testEvidence.state,
    originalTestOutcomesPreserved: true,
    completeConfigurationInventoryAssessed: false,
    qualificationComplete: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
}
async function json(file, maximum) {
  const identity = await identifyFile(file, maximum),
    bytes = await readFile(file);
  assert.deepEqual({ bytes: bytes.length, sha256: sha(bytes) }, identity);
  return JSON.parse(bytes.toString("utf8"));
}
async function main(args) {
  assert.equal(args.length, 4);
  assert.equal(args[0], "--result");
  assert.equal(args[2], "--controller-exit");
  assert.match(args[3], /^\d{1,3}$/u);
  const root = path.resolve(args[1]);
  const recipe = await json(path.join(directory, "binutils.v1.json"), 1048576);
  const receipt = await json(path.join(root, "receipt.json"), 16 * 1024 ** 2);
  const expected = {
    recipeSha256: (await identifyFile(path.join(directory, "binutils.v1.json")))
      .sha256,
    controllerSha256: (
      await identifyFile(
        fileURLToPath(
          new URL("./qualify-binutils-producer.mjs", import.meta.url),
        ),
      )
    ).sha256,
  };
  const summary = validateBuildObservation(
    receipt,
    recipe,
    expected,
    Number(args[3]),
  );
  const observerLog = path.join(root, "retention-observer.jsonl");
  const observerBytes = await readFile(observerLog);
  assert.deepEqual(
    await identifyFile(observerLog, 16 * 1024 ** 2),
    receipt.retentionObserver.log,
  );
  assert.deepEqual(
    { bytes: observerBytes.length, sha256: sha(observerBytes) },
    receipt.retentionObserver.log,
  );
  reconcileRetentionLog(observerBytes, receipt.retentionObserver);
  await validateInputs(path.join(root, "bundle"), recipe.files);
  await validateInputs(path.join(root, "controls"), recipe.controllerFiles);
  assert.deepEqual(
    await identifyFile(
      path.join(root, "build.log"),
      recipe.limits.logByteLimit,
    ),
    receipt.log,
  );
  const reports = await json(
    path.join(root, "work/test-reports.json"),
    8 * 1024 ** 2,
  );
  const minimum = await json(
    path.join(directory, "binutils-expectations.v1.json"),
    65536,
  );
  assert.deepEqual(
    await summarizeReports(
      reports,
      path.join(root, "work/original-test-reports"),
      minimum,
    ),
    receipt.testEvidence,
  );
  assert.deepEqual(
    (await readdir(path.join(root, "work/output"))).sort(),
    receipt.outputs.files.map((row) => row.file).sort(),
    "Physical package output inventory changed",
  );
  for (const row of receipt.outputs.files) {
    assert.match(
      row.file,
      /^[A-Za-z0-9][A-Za-z0-9.+_~-]*\.(deb|udeb|changes|buildinfo)$/u,
    );
    assert.deepEqual(
      await identifyFile(
        path.join(root, "work/output", row.file),
        recipe.limits.workByteLimit,
      ),
      { bytes: row.bytes, sha256: row.sha256 },
    );
  }
  assert.deepEqual(
    await identifyFile(
      path.join(root, "work/native-build-worktree.tar"),
      recipe.limits.workByteLimit,
    ),
    receipt.retainedNativeWorktree,
  );
  await writeFile(
    path.join(root, "build-observation.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(JSON.stringify(summary) + "\n");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
