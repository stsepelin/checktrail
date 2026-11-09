import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test(
  "Go and PHP evaluation controls run against a fresh offline production install",
  { timeout: 180000 },
  () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const verifier = fileURLToPath(
      new URL(
        "../../scripts/verify-evaluation-native-package.mjs",
        import.meta.url,
      ),
    );
    const result = spawnSync(process.execPath, [verifier], {
      env,
      encoding: "utf8",
      timeout: 150000,
      maxBuffer: 4 * 1048576,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.profile, "evaluation-go-php-controls");
    assert.equal(packet.offlineProductionInstall, true);
    assert.equal(packet.lifecycleScriptsExecuted, false);
    assert.equal(packet.harnessOutsideInstalledPackage, true);
    assert.equal(packet.profileEvidence.complete, true);
    assert.equal(packet.profileEvidence.required, 6);
    assert.equal(packet.profileEvidence.ledger.cases.length, 6);
    assert.ok(
      packet.profileEvidence.ledger.cases.every(
        (row: { outcome: string }) => row.outcome === "passed",
      ),
    );
    assert.ok(packet.profileEvidence.ledger.events.length >= 6);
    assert.ok(
      packet.profileEvidence.ledger.events.every(
        (row: { outcome: string }) => row.outcome === "passed",
      ),
    );
    assert.equal(packet.profileEvidence.ledger.truncated, false);
    for (const field of [
      "nativeToolchainsExecuted",
      "independentEvaluationProfileComplete",
      "gateAComplete",
      "inferenceExecuted",
      "fieldEvaluationExecuted",
    ])
      assert.equal(packet[field], false);
  },
);
