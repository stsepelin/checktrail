// Diagnostic-only original synthetic upgrade callback. Never a review trial.
import assert from "node:assert/strict";
import process from "node:process";
import { runRequiredTests } from "./required-test-evidence.mjs";
assert.equal(process.platform, "win32");
const receipt = await runRequiredTests(
  [
    {
      file: "dist/test/gate-resource-release-readiness.test.js",
      name: "resource-release-readiness near-miss acceptance",
    },
  ],
  { timeoutMs: 300000, isolatedCaseWorkers: 1 },
);
assert.equal(receipt.complete, true, JSON.stringify(receipt.problems));
assert.equal(receipt.passed, 1);
process.stdout.write(
  JSON.stringify({
    diagnostic: "original-windows-upgrade-callback",
    receipt,
    wholeResourceProfileQualified: false,
    gateAComplete: false,
    inferenceInvoked: false,
  }) + "\n",
);
