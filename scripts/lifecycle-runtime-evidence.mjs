import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { checkReviewRuntimeSelection } from "./review-runtime-evidence.mjs";

export const lifecycleHarnessFiles = Object.freeze([
  "package.json",
  "package-lock.json",
  "docs/gate-a-profiles.v1.json",
  "dist/test/gate-lifecycle-platforms.test.js",
  "dist/test/lifecycle-platforms-fixture.js",
  "dist/test/lifecycle-platforms-boundaries.js",
  "dist/test/lifecycle-platforms-interruption.js",
  "dist/test/process-tree.test.js",
  "dist/test/posix-owner.test.js",
  "dist/test/runner.test.js",
  "dist/test/process-output.test.js",
  "dist/test/windows-contract.test.js",
  "dist/test/windows-process.test.js",
  "dist/test/helpers.js",
  "dist/test/tool-fixture.js",
  "scripts/verify-lifecycle-platforms.mjs",
  "scripts/verify-lifecycle-platforms-package.mjs",
  "scripts/lifecycle-runtime-evidence.mjs",
  "scripts/review-runtime-evidence.mjs",
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/install-acceptance-package.mjs",
  "scripts/runtime-installation-capture.mjs",
]);
export function lifecycleFoundationSelection(platform = process.platform) {
  assert.ok(
    ["darwin", "linux", "win32"].includes(platform),
    "Unsupported lifecycle platform",
  );
  return platform === "win32"
    ? ["windows-process", "physical-process-output"]
    : ["posix-cleanup", "posix-owner"];
}

export const lifecycleDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

// Observed identities do not authenticate a hosted image or its publisher.
// An unselected development run cannot qualify one of the frozen runtime slots.
export async function observeLifecycleRuntime(scope, slot) {
  let distributionBytes = null;
  const distribution = new Map();
  if (process.platform === "linux") {
    distributionBytes = await readFile("/etc/os-release");
    assert.ok(distributionBytes.length <= 16384);
    for (const line of distributionBytes.toString("utf8").split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (match) distribution.set(match[1], match[2].replace(/^"(.*)"$/, "$1"));
    }
  }
  const observed = {
    slot,
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    distributionId: distribution.get("ID") ?? null,
    distributionVersion: distribution.get("VERSION_ID") ?? null,
    distributionSha256: distributionBytes
      ? lifecycleDigest(distributionBytes)
      : null,
    imageOS: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    containerImageId: process.env.CHECKTRAIL_REVIEW_RUNTIME_IMAGE_ID ?? null,
    nodeExecutableSha256: lifecycleDigest(await readFile(process.execPath)),
    hostedImageMetadataAttested: false,
    containerImageMetadataAttested: false,
  };
  return {
    ...observed,
    selectedRuntime: checkReviewRuntimeSelection(
      scope,
      slot,
      observed,
      slot !== null && process.env.GITHUB_ACTIONS === "true",
    ),
  };
}

export function requireLifecycleRuntimeInstallation(
  receipt,
  source,
  definitions,
) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.profile, "lifecycle-platforms-installed-v1");
  assert.equal(receipt.offlineProductionInstall, true);
  assert.equal(receipt.lifecycleScriptsExecuted, false);
  assert.equal(receipt.harnessOutsideInstalledPackage, true);
  assert.match(receipt.tarballSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.productionDependencyLockSha256, /^[a-f0-9]{64}$/);
  const evidence = receipt.evidence;
  assert.equal(evidence.profile, "lifecycle-platforms-runtime-v1");
  assert.equal(evidence.installed, true);
  assert.equal(evidence.installedEvidence, null);
  assert.deepEqual(
    evidence.runtime,
    source.runtime,
    "Installed lifecycle runtime differs from source",
  );
  assert.equal(evidence.compiledEngine.beforeAfterByteIdentitiesMatch, true);
  for (const engine of [receipt.compiledEngine, evidence.compiledEngine]) {
    for (const key of [
      "schemaVersion",
      "fileCount",
      "bytes",
      "treeSha256",
      "manifestSha256",
    ])
      assert.equal(
        engine[key],
        source.compiledEngine[key],
        "Installed lifecycle engine differs from source",
      );
  }
  assert.equal(
    receipt.harnessSha256,
    source.harnessSha256,
    "Installed lifecycle harness differs from source",
  );
  assert.equal(evidence.harnessSha256, source.harnessSha256);
  assert.deepEqual(evidence.inputSources, source.inputSources);
  assert.equal(evidence.harnessInputsUnchanged, true);
  function complete(profile, rows) {
    assert.equal(profile.complete, true);
    assert.equal(profile.required, rows.length);
    assert.equal(profile.passed, rows.length);
    assert.equal(profile.ledger.truncated, false);
    assert.equal(profile.ledger.cases.length, rows.length);
    assert.ok(profile.ledger.cases.every((row) => row.outcome === "passed"));
    assert.deepEqual(
      profile.ledger.cases.map((row) => row.name).sort(),
      rows.map((row) => row.name).sort(),
    );
  }
  complete(evidence, definitions["lifecycle-platforms"]);
  const selection = lifecycleFoundationSelection(source.runtime.platform);
  assert.deepEqual(
    evidence.foundation.profiles,
    selection.map((profile) => ({
      profile,
      required: definitions[profile].length,
    })),
  );
  complete(
    evidence.foundation,
    selection.flatMap((profile) => definitions[profile]),
  );
  assert.equal(
    evidence.completionScope,
    "whole-profile-and-selected-platform-foundation",
  );
  assert.equal(evidence.inferenceInvoked, false);
  assert.equal(evidence.fieldEvaluationExecuted, false);
  assert.equal(evidence.gateAComplete, false);
  return receipt;
}
