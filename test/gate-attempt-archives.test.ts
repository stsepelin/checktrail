import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  archiveBroken,
  archiveRepair,
  archiveNear,
  archiveStore,
  archiveCallers,
  archiveStale,
  archiveEmpty,
} from "./attempt-whole-controls.js";
import {
  archivePrerequisite,
  archivePrivacy,
  archiveLifecycle,
} from "./attempt-whole-boundaries.js";
test("attempt-archives broken acceptance", { timeout: 180000 }, async (t) => {
  await archiveBroken(t);
  await archiveCallers(t);
});
test("attempt-archives fixed acceptance", { timeout: 180000 }, archiveRepair);
test("attempt-archives near-miss acceptance", { timeout: 90000 }, archiveNear);
test(
  "attempt-archives prerequisite acceptance",
  { timeout: 90000 },
  archivePrerequisite,
);
test("attempt-archives stale acceptance", { timeout: 120000 }, archiveStale);
test("attempt-archives empty acceptance", { timeout: 180000 }, archiveEmpty);
test(
  "attempt-archives privacy acceptance",
  { timeout: 300000 },
  archivePrivacy,
);
test(
  "attempt-archives lifecycle acceptance",
  { timeout: 240000 },
  archiveLifecycle,
);
test(
  "attempt-archives installed acceptance",
  { timeout: process.platform === "win32" ? 600000 : 240000 },
  async (t) => {
    if (process.env.CHECKTRAIL_ATTEMPT_WHOLE_INSTALLED === "1") {
      const actual = await realpath(
        fileURLToPath(new URL("../src/engine.js", import.meta.url)),
      );
      assert.ok(
        actual.includes(
          path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
        ),
      );
      await archiveStore(t);
      return;
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-attempt-archives-whole-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      {
        env,
        encoding: "utf8",
        timeout: process.platform === "win32" ? 590000 : 230000,
        maxBuffer: 8 * 1048576,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      0,
      (result.stdout + result.stderr).slice(-5000),
    );
    const receipt = JSON.parse(result.stdout);
    if (process.env.CHECKTRAIL_ATTEMPT_RUNTIME_ACTIVE === "1") {
      const file = process.env.CHECKTRAIL_ATTEMPT_RUNTIME_RECEIPT;
      assert.equal(typeof file, "string");
      assert.ok(path.isAbsolute(file!));
      await writeFile(file!, JSON.stringify(receipt), {
        flag: "wx",
        mode: 0o600,
      });
    }
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    assert.equal(receipt.profileEvidence.complete, true);
    assert.equal(receipt.profileEvidence.passed, 9);
    assert.equal(receipt.profileEvidence.ledger.truncated, false);
  },
);
