import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-phpstan", args: [], cwd: "." };
const check: Check = {
  id: "php.phpstan",
  adapter: "php",
  project: ".",
  scope: ["Example.php"],
  kind: "analysis",
  parser: "phpstan-json",
  commands: [command],
  reason: "Synthetic evidence",
};
const processResult: ProcessResult = {
  command,
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  truncated: false,
};
const report = () => ({
  totals: { errors: 0, file_errors: 0 },
  files: {},
  errors: [],
});
const parse = (
  value: unknown,
  files = ["/synthetic/Example.php"],
  patch: Partial<ProcessResult> = {},
) =>
  evaluate(
    check,
    [
      {
        ...processResult,
        stdout: [...files, JSON.stringify(value)].join("\n"),
        ...patch,
      },
    ],
    "/synthetic",
  );

test("PHPStan requires exact debug paths and reconciled JSON counters", () => {
  assert.equal(parse(report()).status, "passed");
  for (const files of [
    [],
    ["/other/Example.php"],
    ["/synthetic/Example.php", "/synthetic/Example.php"],
  ])
    assert.equal(parse(report(), files).status, "inconclusive");
  assert.equal(
    parse({ ...report(), totals: { errors: 0, file_errors: 1 } }).status,
    "inconclusive",
  );
  const failed = {
    totals: { errors: 0, file_errors: 1 },
    files: {
      "/synthetic/Example.php": {
        errors: 1,
        messages: [
          {
            message: "Return type mismatch",
            line: 2,
            ignorable: true,
            identifier: "return.type",
          },
        ],
      },
    },
    errors: [],
  };
  assert.equal(parse(failed).status, "failed");
  assert.deepEqual(parse(failed).findings, [
    {
      ruleId: "return.type",
      level: "error",
      message: "Return type mismatch",
      file: "Example.php",
      line: 2,
    },
  ]);
  failed.files["/synthetic/Example.php"].errors = 2;
  assert.equal(parse(failed).status, "inconclusive");
  for (const patch of [
    { stdout: "bad-json" },
    { timedOut: true },
    { cancelled: true },
    { truncated: true },
  ])
    assert.equal(parse(report(), undefined, patch).status, "inconclusive");
  assert.equal(
    parse(report(), undefined, { stdout: "configuration error", exitCode: 1 })
      .status,
    "error",
  );
});
