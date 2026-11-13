import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";

export const scalaNativeCiPhases = Object.freeze([
  "baseline",
  "source",
  "installed",
  "guards",
]);

export function selectScalaNativeCiPhase(args) {
  assert.ok(
    args.length === 0 ||
      (args.length === 2 &&
        args[0] === "--phase" &&
        scalaNativeCiPhases.includes(args[1])),
    "Unknown Scala extension CI phase selection; use --phase baseline|source|installed|guards",
  );
  return args[1];
}

// A fragment must remain tied to the original closed nine-case profile. A
// renamed, duplicated or newly added callback needs an explicit phase decision.
export function selectScalaExtensionSourceRequirements(requirements) {
  const expected = [
    "broken",
    "fixed",
    "near-miss",
    "prerequisite",
    "stale",
    "empty",
    "privacy",
    "lifecycle",
    "installed",
  ].map((name) => ({
    file: "dist/test/gate-scala-extensions.test.js",
    name: `scala-extensions ${name} acceptance`,
  }));
  assert.deepEqual(
    requirements,
    expected,
    "Scala extension phase inventory must match all nine original callbacks",
  );
  return requirements.slice(0, -1);
}

export async function runScalaExtensionSource(requirements, engineRoot) {
  const selected = selectScalaExtensionSourceRequirements(requirements);
  const before = await captureCompiledEngine(engineRoot);
  const result = await runRequiredTests(selected, {
    timeoutMs: 600000,
    isolatedCaseWorkers: 1,
  });
  const compiledEngine = requireUnchangedCompiledEngine(
    before,
    await captureCompiledEngine(engineRoot),
  );
  assert.equal(result.required, 8);
  assert.equal(result.passed, 8);
  assert.equal(result.complete, true, JSON.stringify(result.problems));
  return {
    profile: "scala-extensions",
    timeoutMs: 600000,
    ...result,
    compiledEngine,
    fullProfileRequired: requirements.length,
    selectedCohortComplete: true,
    phaseComplete: true,
    complete: false,
    wholeProfileComplete: false,
  };
}

export async function runScalaNativeCiPhase(phase, handlers, requirements) {
  assert.ok(scalaNativeCiPhases.includes(phase), "Unknown Scala native phase");
  selectScalaExtensionSourceRequirements(requirements["scala-extensions"]);
  assert.equal(
    typeof handlers[phase],
    "function",
    "Missing Scala phase handler",
  );
  const receipt = await handlers[phase]();
  if (phase === "baseline") {
    assert.equal(
      receipt.baseline.required,
      requirements.scala.length + requirements.java.length,
    );
    assert.equal(receipt.baseline.complete, true);
    assert.deepEqual(
      ["tests", "passed", "failed", "skipped"].map(
        (key) => receipt.regressions[key],
      ),
      [4, 4, 0, 0],
    );
    assert.equal(receipt.installedJavaWarningPolicy.acceptance.complete, true);
    assert.equal(receipt.installedJavaWarningPolicy.acceptance.passed, 1);
  } else if (phase === "source") {
    assert.equal(receipt.source.required, 8);
    assert.equal(receipt.source.passed, 8);
    assert.equal(receipt.source.selectedCohortComplete, true);
    assert.equal(receipt.source.phaseComplete, true);
    assert.equal(receipt.source.complete, false);
    assert.equal(receipt.source.wholeProfileComplete, false);
    assert.equal(
      receipt.source.compiledEngine.beforeAfterByteIdentitiesMatch,
      true,
    );
  } else if (phase === "installed") {
    assert.equal(receipt.installed.profile.required, 9);
    assert.equal(receipt.installed.profile.passed, 9);
    assert.equal(receipt.installed.profile.complete, true);
    assert.equal(receipt.installed.offlineProductionInstall, true);
    assert.equal(receipt.installed.lifecycleScriptsExecuted, false);
    assert.equal(receipt.installed.harnessOutsideInstalledPackage, true);
    assert.equal(
      receipt.installed.profile.compiledEngine.beforeAfterByteIdentitiesMatch,
      true,
    );
  } else {
    assert.equal(receipt.guards.controls.length, 13);
    assert.equal(receipt.guards.allComplete, true);
    assert.ok(
      receipt.guards.controls.every(
        (control) =>
          control.originalPassed &&
          control.mutantCompiled &&
          control.mutantFailedAssertion &&
          control.restoredPassed,
      ),
    );
  }
  return {
    ...receipt,
    phase,
    phaseComplete: true,
    complete: false,
    wholeProfileComplete: false,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  assert.deepEqual(process.argv.slice(2), ["--source"]);
  const requirements = JSON.parse(
    await readFile(
      new URL("./required-native-tests.json", import.meta.url),
      "utf8",
    ),
  );
  const result = await runScalaExtensionSource(
    requirements["scala-extensions"],
    new URL("../dist/src/", import.meta.url),
  );
  process.stdout.write(JSON.stringify(result) + "\n");
}
