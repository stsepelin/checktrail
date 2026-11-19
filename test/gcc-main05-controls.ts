import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

const groups = {
  core: [
    "attempt",
    "capacity",
    "driver",
    "export",
    "history",
    "ledger",
    "observer",
    "retain",
    "sdk",
    "sdk_image",
    "service",
    "stage",
    "start",
    "state",
    "transport",
  ].map((name) => "main05_" + name),
  continuation: [
    "finite_phase_contract",
    "staged_host_activation",
    "staged_host_bridge",
    "staged_selected_body",
    "staged_phase_evidence",
  ],
  native: ["native05_noexport", "native05_sdk_local", "native05_assembly"],
};

export function runGccMain05Group(t: TestContext, group: keyof typeof groups) {
  if (process.platform === "win32") {
    t.skip("The selected original GCC main05 carrier requires POSIX");
    return;
  }
  const result = spawnSync(
    "python3",
    ["-I", "-B", "test/gcc-main05-cases.py", group],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    },
  );
  const failureOutput = JSON.stringify({
    stdoutTail: result.stdout?.slice(-4096),
    stderrTail: result.stderr?.slice(-8192),
  });
  assert.equal(result.error, undefined, failureOutput);
  assert.equal(result.signal, null, failureOutput);
  assert.equal(result.status, 0, failureOutput);
  const counts = JSON.parse(result.stdout);
  assert.ok(counts.tests > 0);
  assert.equal(counts.failures + counts.errors + counts.skips, 0);
  assert.equal(counts.sourceOrCompilerOrSdkOrDockerExecuted, false);
  assert.equal(counts.native05Granted, false);
  assert.deepEqual(counts.groupManifest, groups);
  const modules = Object.values(groups).flat();
  assert.equal(
    new Set(modules).size,
    modules.length,
    "Synthetic case groups overlap",
  );
  assert.deepEqual(counts.selectedGroups, [group]);
  assert.deepEqual(counts.executedCaseModules, [...groups[group]].sort());
  assert.equal(counts.tests, counts.discoveredCases);
}
