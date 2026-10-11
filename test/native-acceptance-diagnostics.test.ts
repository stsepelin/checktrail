import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const helper = await import(
  new URL("../../scripts/native-acceptance-diagnostics.mjs", import.meta.url)
    .href
);
test("native acceptance diagnostics retain the failed named case before a large terminal ledger without changing the actual subprocess failure", () => {
  const problem = {
    name: "original installed fixed acceptance",
    reason: "failed",
    code: "ERR_ASSERTION",
    message:
      "original native phase=build;exit=null;signal=SIGKILL;errno=ETIMEDOUT",
  };
  const receipt = {
    profile: "original-synthetic",
    complete: false,
    passed: 8,
    required: 9,
    problems: [problem],
    ledger: { events: "x".repeat(50000) },
  };
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "console.log('original prefix');console.log(JSON.stringify({..." +
        JSON.stringify({ ...receipt, ledger: undefined }) +
        ",ledger:{events:'x'.repeat(50000)}}));process.exitCode=1",
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 100000 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  const before = child.stdout;
  const diagnostic = helper.nativeAcceptanceFailure(child) as string;
  assert.ok(diagnostic.length <= 3000);
  assert.ok(diagnostic.indexOf(problem.name) < 250);
  assert.ok(diagnostic.includes(problem.message));
  assert.ok(diagnostic.includes('"passed":8'));
  assert.ok(diagnostic.includes('"required":9'));
  assert.equal(diagnostic.includes("ledger"), false);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, before);
});
test("native acceptance diagnostics distinguish malformed empty and completed receipts and escape terminal controls within bounded fallback evidence", () => {
  for (const output of [
    "",
    "{malformed}",
    JSON.stringify({
      complete: true,
      problems: [{ name: "must not invent an incomplete receipt" }],
    }),
  ]) {
    const result = helper.nativeAcceptanceFailure({
      stdout: output,
      stderr: "",
      message: "original fallback",
    }) as string;
    assert.ok(result.startsWith("Native acceptance subprocess failed: "));
  }
  const original =
    "original native failure\u001b[31m\n" +
    "x".repeat(50000) +
    "original terminal cause";
  const result = helper.nativeAcceptanceFailure({
    stderr: Buffer.from(original),
  }) as string;
  assert.ok(result.length <= 3000);
  assert.ok(result.includes("original native failure"));
  assert.ok(result.includes("original terminal cause"));
  assert.equal(result.includes("\u001b"), false);
  assert.equal(result.includes("\n"), false);
});
