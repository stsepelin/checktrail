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
