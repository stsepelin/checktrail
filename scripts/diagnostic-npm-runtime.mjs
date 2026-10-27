import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
assert.equal(process.versions.node, process.env.CHECKTRAIL_NPM_EXPECTED_NODE);
assert.equal(process.platform, process.env.CHECKTRAIL_NPM_EXPECTED_PLATFORM);
assert.equal(process.arch, process.env.CHECKTRAIL_NPM_EXPECTED_ARCH);
const files = [
  "package.json",
  "package-lock.json",
  "scripts/audit-dependencies.mjs",
  "scripts/license-sources.json",
];
const inputSources = await Promise.all(
  files.map(async (file) => [
    file,
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  ]),
);
await writeFile(
  "npm-notice-runtime.json",
  JSON.stringify(
    {
      schemaVersion: 1,
      scope:
        "Diagnostic installed npm notice scope; no native engine or review-quality qualification",
      slot: process.env.CHECKTRAIL_NPM_SLOT,
      sourceCommit: process.env.GITHUB_SHA,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      osVersion: os.version(),
      osRelease: os.release(),
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      containerReference:
        process.env.CHECKTRAIL_NPM_CONTAINER_REFERENCE ?? null,
      containerImageId: process.env.CHECKTRAIL_NPM_CONTAINER_IMAGE_ID ?? null,
      inputSources,
      selectedRuntimeMatrixQualified: false,
      gateAComplete: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
