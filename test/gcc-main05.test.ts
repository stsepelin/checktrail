import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("GCC original main05 synthetic capture, failure, and service controls", (t) => {
  if (process.platform === "win32") {
    t.skip("The selected original GCC main05 carrier requires POSIX");
    return;
  }
  const result = spawnSync(
    "python3",
    ["-I", "-B", "test/gcc-main05-cases.py"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const counts = JSON.parse(result.stdout);
  assert.ok(counts.tests > 0);
  assert.equal(counts.failures + counts.errors + counts.skips, 0);
  assert.equal(counts.sourceOrCompilerOrSdkOrDockerExecuted, false);
  assert.equal(counts.native05Granted, false);
  assert.ok(Array.isArray(counts.executedCaseModules));
  for (const caseModule of [
    "staged_host_activation",
    "staged_host_bridge",
    "staged_selected_body",
    "staged_phase_evidence",
    "native05_noexport",
    "native05_sdk_local",
    "native05_assembly",
  ]) {
    assert.ok(
      counts.executedCaseModules.includes(caseModule),
      `Missing executed GCC suite: ${caseModule}`,
    );
  }
});
