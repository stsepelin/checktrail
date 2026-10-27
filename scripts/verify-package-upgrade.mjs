// Explicit operator verification; no package publication or model is invoked.
import assert from "node:assert/strict";
import process from "node:process";
import { verifyPackageUpgrade } from "./package-upgrade-readiness.mjs";
assert.equal(
  process.argv.length,
  4,
  "Usage: node scripts/verify-package-upgrade.mjs BASELINE_TGZ CANDIDATE_TGZ",
);
process.stdout.write(
  JSON.stringify(
    await verifyPackageUpgrade(process.argv[2], process.argv[3]),
    null,
    2,
  ) + "\n",
);
