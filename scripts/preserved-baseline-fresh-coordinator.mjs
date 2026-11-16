import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import {
  installAcceptancePackage,
  runAcceptanceNpm,
} from "./install-acceptance-package.mjs";
import {
  callbackIdentities,
  prepareBaselineHarness,
} from "./preserved-baseline-evidence.mjs";

export function baselineRuntimeBinding(cohort) {
  return {
    platform: cohort.platform,
    nodeMajor: cohort.nodeMajor,
    ...(cohort.nodeVersion ? { nodeVersion: cohort.nodeVersion } : {}),
    ...(cohort.gitVersion ? { gitVersion: cohort.gitVersion } : {}),
    ...(cohort.selectors ? { selectors: cohort.selectors } : {}),
    tools: cohort.tools,
    toolVersionAssertions: cohort.toolVersionAssertions ?? {},
  };
}

// The existing controller owns the one source execution and its native context.
// This function only launches the physically fresh installed phase.
export async function runFreshBaselineAtInstallation({
  repository,
  sourceRoot = repository,
  sourceCapture,
  expectedSourceScope,
  preparedDirectories = [],
  installedPackage,
  harness,
  launchWorker,
}) {
  assert.equal(
    typeof launchWorker,
    "function",
    "Fresh worker launcher missing",
  );
  assert.equal(sourceCapture?.originalExecutionInvocations, 1);
  assert.deepEqual(sourceCapture.sourceScope, expectedSourceScope);
  repository = await realpath(repository);
  const expectedEngine = await captureCompiledEngine(
    path.join(repository, "dist/src"),
  );
  requireUnchangedCompiledEngine(sourceCapture.compiledEngine, expectedEngine);
  assert.deepEqual(
    sourceCapture.callbacks,
    await callbackIdentities(
      repository,
      expectedSourceScope.baselineProfiles,
      expectedSourceScope.baselineSelection,
    ),
    "Source callback bytes changed before fresh installation",
  );
  const inputFile = harness + ".input.json";
  for (const target of [harness, inputFile]) {
    const existing = await lstat(target).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    assert.equal(
      existing,
      undefined,
      "Fresh coordinator target already exists",
    );
  }
  try {
    await prepareBaselineHarness({
      repository,
      harness,
      installedPackage,
      preparedDirectories,
    });
    const input = {
      mode: "fresh-from-original-source",
      root: harness,
      profiles: expectedSourceScope.baselineProfiles,
      selection: expectedSourceScope.baselineSelection,
      expectedCallbacks: sourceCapture.callbacks,
      expectedEngine,
      binding: expectedSourceScope.binding,
      sourceCapture,
      expectedSourceScope,
      sourceRoot,
      installedPackage,
      sourceEngine: path.join(sourceRoot, "dist/src"),
    };
    await writeFile(inputFile, JSON.stringify(input), {
      flag: "wx",
      mode: 0o600,
    });
    const output = await launchWorker({
      repository,
      temporary: path.dirname(harness),
      harness,
      inputFile,
      worker: path.join(harness, "scripts/preserved-baseline-worker.mjs"),
    });
    assert.equal(typeof output, "string", "Fresh worker output missing");
    const report = JSON.parse(output);
    assert.equal(report.profile, "preserved-baseline-source-reused-fresh-v1");
    assert.equal(report.sourceCallbacksReexecuted, false);
    assert.equal(report.sourceAndFreshSubsetComplete, true);
    assert.equal(report.wholeSuiteQualification, false);
    assert.equal(report.fresh.complete, true);
    assert.deepEqual(report.fresh.problems, []);
    assert.equal(
      report.fresh.required,
      sourceCapture.callbacks.uniqueCallbacks,
    );
    requireUnchangedCompiledEngine(
      expectedEngine,
      await captureCompiledEngine(path.join(repository, "dist/src")),
    );
    assert.deepEqual(
      sourceCapture.callbacks,
      await callbackIdentities(
        repository,
        expectedSourceScope.baselineProfiles,
        expectedSourceScope.baselineSelection,
      ),
    );
    return report;
  } finally {
    await rm(inputFile, { force: true });
    await rm(harness, { recursive: true, force: true });
  }
}

// Host fragments need one pack/install. Container controllers can reuse their
// existing fresh installation with runFreshBaselineAtInstallation instead.
export async function completeFreshBaseline(options) {
  const repository = await realpath(options.repository);
  const temporary = await realpath(
    await mkdtemp(path.join(tmpdir(), "checktrail-baseline-fresh-")),
  );
  try {
    const packed = JSON.parse(
      runAcceptanceNpm(
        [
          "pack",
          "--offline",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          temporary,
        ],
        {
          cwd: repository,
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        },
      ),
    );
    assert.equal(packed.length, 1);
    assert.equal(path.basename(packed[0].filename), packed[0].filename);
    const tarball = path.join(temporary, packed[0].filename);
    const packageInputs = {};
    for (const [name, file] of [
      ["package.json", path.join(repository, "package.json")],
      ["package-lock.json", path.join(repository, "package-lock.json")],
      ["tarball", tarball],
    ]) {
      const bytes = await readFile(file);
      packageInputs[name] = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    const consumer = path.join(temporary, "consumer");
    const installation = await installAcceptancePackage(
      repository,
      tarball,
      consumer,
    );
    const report = await runFreshBaselineAtInstallation({
      ...options,
      repository,
      sourceRoot: options.sourceRoot ?? repository,
      installedPackage: path.join(
        consumer,
        "node_modules/@stsepelin/checktrail",
      ),
      harness: path.join(temporary, "harness"),
    });
    return { ...report, installation, packageInputs };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
