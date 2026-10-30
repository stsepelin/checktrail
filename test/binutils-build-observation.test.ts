import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const { validateBuildObservation } = await import(
  pathToFileURL(
    path.join(repository, "scripts/verify-binutils-build-observation.mjs"),
  ).href
);
const recipe = JSON.parse(
  readFileSync(
    path.join(repository, "scripts/producer-qualification/binutils.v1.json"),
    "utf8",
  ),
);
const expected = {
  recipeSha256: "a".repeat(64),
  controllerSha256: "b".repeat(64),
};
const valid = () => ({
  state: "build-completed-qualification-incomplete",
  profile: recipe.profile,
  ...expected,
  image: recipe.image,
  platform: recipe.platform,
  pinnedInputs: recipe.files.length,
  command: recipe.command,
  buildExecuted: true,
  originalBuild: {
    invoked: true,
    exitCode: 0,
    commandCompleted: true,
    wrapperExitCode: 0,
  },
  executionObserver: {
    exitCode: 0,
    signal: null,
    error: null,
    reason: null,
    stopError: null,
    retainedBytes: 25,
  },
  cleanup: { state: "absent" },
  retainedWorkBytes: 25,
  retentionObserver: {
    state: "completed",
    independentImage: recipe.image,
    readOnly: true,
    network: "none",
    capability: "DAC_READ_SEARCH",
    nativeFilesystemQuotaEnforced: false,
    terminal: { exitCode: 0, signal: null },
    samples: 2,
    lastSample: {
      schemaVersion: 1,
      kind: "sample",
      sequence: 2,
      bytes: 25,
      files: 4,
      directories: 3,
    },
    retainedLogBytes: 80,
    log: { bytes: 80, sha256: "c".repeat(64) },
  },
  retentionObserverCleanup: { state: "absent" },
  runtime: {
    platform: "linux",
    architecture: "x64",
    kernelMachine: "x86_64",
    dockerArchitecture: "amd64",
  },
  testEvidence: {
    state: "reported",
    minimumSourceObligationsSatisfied: true,
    completeConfigurationInventoryAssessed: false,
  },
  buildCompletion: {
    state: "build-completed-qualification-incomplete",
    testEvidenceState: "reported",
    qualificationComplete: false,
  },
  outputs: { files: [{ file: "binutils_2.40-2_amd64.deb", bytes: 12 }] },
  qualificationComplete: false,
  fullCompilerSdkBootstrapClosureVerified: false,
  completeOriginalNoticeClosureVerified: false,
  gateAComplete: false,
  inferenceInvoked: false,
  fieldEvaluationExecuted: false,
});

test("original successful package completion is scoped separately from complete upstream qualification", () => {
  const result = validateBuildObservation(valid(), recipe, expected, 2);
  assert.equal(result.state, "original-package-build-completed");
  assert.equal(result.originalCommandExitCode, 0);
  assert.equal(result.originalTestEvidenceState, "reported");
  for (const key of [
    "qualificationComplete",
    "fullCompilerSdkBootstrapClosureVerified",
    "completeOriginalNoticeClosureVerified",
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    assert.equal(result[key], false);
});
test("failed or unavailable upstream outcomes retain their exact state after an original package success", () => {
  for (const state of ["failed", "unavailable"]) {
    const receipt = valid();
    receipt.testEvidence.state = state;
    receipt.buildCompletion.testEvidenceState = state;
    const result = validateBuildObservation(receipt, recipe, expected, 2);
    assert.equal(result.originalTestEvidenceState, state);
    assert.equal(result.originalTestOutcomesPreserved, true);
    assert.equal(result.qualificationComplete, false);
  }
});
test("wrong controller exit and every incomplete native terminal dimension are refused", () => {
  for (const exit of [0, 1, 137, null])
    assert.throws(() =>
      validateBuildObservation(valid(), recipe, expected, exit),
    );
  const edits: ((receipt: ReturnType<typeof valid>) => void)[] = [
    (r) => (r.originalBuild.invoked = false),
    (r) => (r.originalBuild.exitCode = 1),
    (r) => (r.originalBuild.commandCompleted = false),
    (r) => (r.originalBuild.wrapperExitCode = 1),
    (r) => (r.buildExecuted = false),
    (r) => (r.executionObserver.exitCode = 1),
    (r) => Object.assign(r.executionObserver, { signal: "SIGTERM" }),
    (r) => Object.assign(r.executionObserver, { error: "spawn failed" }),
    (r) => Object.assign(r.executionObserver, { reason: "deadline" }),
    (r) => Object.assign(r.executionObserver, { stopError: "cleanup failed" }),
    (r) => (r.executionObserver.retainedBytes = recipe.limits.logByteLimit + 1),
    (r) => (r.cleanup.state = "pending"),
  ];
  for (const edit of edits) {
    const receipt = valid();
    edit(receipt);
    assert.throws(() => validateBuildObservation(receipt, recipe, expected, 2));
  }
});
test("stale source command image platform and incomplete report inventories cannot qualify a build observation", () => {
  const edits: ((receipt: ReturnType<typeof valid>) => void)[] = [
    (r) => (r.recipeSha256 = "0".repeat(64)),
    (r) => (r.controllerSha256 = "0".repeat(64)),
    (r) => (r.image = "other@sha256:" + "0".repeat(64)),
    (r) => (r.platform = "linux/arm64"),
    (r) => (r.command = ["true"]),
    (r) => r.pinnedInputs--,
    (r) => (r.runtime.platform = "darwin"),
    (r) => (r.runtime.architecture = "arm64"),
    (r) => (r.runtime.kernelMachine = "aarch64"),
    (r) => (r.runtime.dockerArchitecture = "arm64"),
    (r) => (r.testEvidence.minimumSourceObligationsSatisfied = false),
    (r) => (r.testEvidence.state = "passed"),
    (r) => (r.buildCompletion.testEvidenceState = "failed"),
    (r) => (r.buildCompletion.qualificationComplete = true),
    (r) => (r.outputs.files = []),
    (r) => (r.outputs.files[0]!.bytes = 0),
    (r) => (r.qualificationComplete = true),
    (r) => (r.fullCompilerSdkBootstrapClosureVerified = true),
    (r) => (r.completeOriginalNoticeClosureVerified = true),
    (r) => (r.gateAComplete = true),
  ];
  for (const edit of edits) {
    const receipt = valid();
    edit(receipt);
    assert.throws(() => validateBuildObservation(receipt, recipe, expected, 2));
  }
});

test("inaccessible stale partial and unclean independent observer outcomes cannot qualify original build completion", () => {
  const edits: ((receipt: ReturnType<typeof valid>) => void)[] = [
    (r) => (r.retentionObserver.state = "unavailable"),
    (r) => (r.retentionObserver.independentImage = "different"),
    (r) => (r.retentionObserver.readOnly = false),
    (r) => (r.retentionObserver.network = "bridge"),
    (r) => (r.retentionObserver.capability = "ALL"),
    (r) => (r.retentionObserver.nativeFilesystemQuotaEnforced = true),
    (r) => (r.retentionObserver.terminal.exitCode = 137),
    (r) => (r.retentionObserver.samples = 0),
    (r) => (r.retentionObserver.lastSample.sequence = 1),
    (r) => (r.retentionObserver.lastSample.bytes = -1),
    (r) => (r.retentionObserver.lastSample.directories = 2),
    (r) => (r.retainedWorkBytes = 24),
    (r) => (r.retentionObserver.retainedLogBytes = 0),
    (r) => (r.retentionObserver.log.bytes = 81),
    (r) => (r.retentionObserver.log.sha256 = "invalid"),
    (r) => (r.retentionObserverCleanup.state = "unavailable"),
  ];
  for (const edit of edits) {
    const receipt = valid();
    edit(receipt);
    assert.throws(() => validateBuildObservation(receipt, recipe, expected, 2));
  }
});
