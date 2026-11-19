import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const expectedCaseModules = [
  "gcc-sdk-material-cases.py",
  "gcc-sdk-hosted-cases.py",
  "gcc-sdk-derived-cases.py",
  "gcc-sdk-derived-run-cases.py",
  "gcc-sdk-format-layout-cases.py",
  "gcc-sdk-structured-diagnostics-cases.py",
  "gcc-sdk-unrecognized-row-cases.py",
  "gcc-sdk-footer-layout-cases.py",
  "gcc-sdk-empty-false-cases.py",
  "gcc-sdk-onhost-receipt-cases.py",
];

test("GCC SDK synthetic controls execute every declared case module", (t) => {
  if (process.platform === "win32") {
    t.skip("The selected original hosted GCC SDK requires POSIX");
    return;
  }
  const result = spawnSync(
    "python3",
    ["-I", "-B", "test/gcc-sdk-reconstruction-cases.py"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.trim().length > 0,
    "SDK case counter receipt missing",
  );
  const counts = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(counts).sort(), [
    "caseModules",
    "dockerCompilerOrUpstreamExecuted",
    "errors",
    "executedCaseModules",
    "expectedCaseIds",
    "expectedFailures",
    "failures",
    "moduleCounts",
    "passedCaseIds",
    "qualified",
    "schemaVersion",
    "skips",
    "startedCaseIds",
    "terminalCaseIds",
    "tests",
    "unexpectedSuccesses",
  ]);
  assert.equal(counts.schemaVersion, 1);
  assert.equal(counts.qualified, true);
  assert.equal(counts.dockerCompilerOrUpstreamExecuted, false);
  assert.deepEqual(
    [...counts.caseModules].sort(),
    [...expectedCaseModules].sort(),
  );
  assert.deepEqual(counts.executedCaseModules, [...expectedCaseModules].sort());
  assert.ok(Number.isInteger(counts.tests) && counts.tests > 0);
  for (const field of [
    "failures",
    "errors",
    "skips",
    "expectedFailures",
    "unexpectedSuccesses",
  ]) {
    assert.equal(counts[field], 0, field);
  }
  for (const field of [
    "expectedCaseIds",
    "startedCaseIds",
    "passedCaseIds",
    "terminalCaseIds",
  ]) {
    const ids = counts[field];
    assert.ok(Array.isArray(ids), field);
    assert.equal(ids.length, counts.tests, field);
    assert.equal(new Set(ids).size, ids.length, field);
    for (const id of ids) assert.equal(typeof id, "string", field);
    assert.deepEqual(
      [...ids].sort(),
      [...counts.expectedCaseIds].sort(),
      field,
    );
  }
  assert.deepEqual(
    Object.keys(counts.moduleCounts).sort(),
    [...expectedCaseModules].sort(),
  );
  let total = 0;
  for (const file of expectedCaseModules) {
    const group = counts.moduleCounts[file];
    assert.deepEqual(Object.keys(group).sort(), [
      "declared",
      "passed",
      "started",
      "terminal",
    ]);
    assert.ok(Number.isInteger(group.declared) && group.declared > 0, file);
    for (const field of ["started", "passed", "terminal"]) {
      assert.equal(group[field], group.declared, file + ": " + field);
    }
    const prefix = file.replace(/\.py$/, "").replaceAll("-", "_") + ".";
    let observed = 0;
    for (const id of counts.startedCaseIds) {
      if (id.startsWith(prefix)) observed += 1;
    }
    assert.equal(observed, group.declared, file);
    total += group.declared;
  }
  assert.equal(total, counts.tests);
});
