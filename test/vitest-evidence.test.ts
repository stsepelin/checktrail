import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-vitest", args: [], cwd: "." };
const check: Check = {
  id: "javascript.vitest",
  adapter: "javascript",
  project: ".",
  scope: ["sum.test.ts"],
  kind: "test",
  parser: "vitest-json",
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
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  testResults: [
    {
      name: "/synthetic/sum.test.ts",
      status: "passed",
      assertionResults: [{ fullName: "adds", status: "passed" }],
    },
  ],
});
const parse = (value: unknown, patch: Partial<ProcessResult> = {}) =>
  evaluate(
    check,
    [{ ...processResult, stdout: JSON.stringify(value), ...patch }],
    "/synthetic",
  );

test("Vitest evidence requires matching file paths, terminal assertions and reconciled counters", () => {
  assert.deepEqual(parse(report()).tests, {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
  });
  const mutations: ((value: ReturnType<typeof report>) => void)[] = [
    (value) => {
      value.testResults = [];
    },
    (value) => {
      value.testResults.push(value.testResults[0]!);
    },
    (value) => {
      value.testResults[0]!.name = "/other/sum.test.ts";
    },
    (value) => {
      value.numTotalTests = 2;
    },
    (value) => {
      value.numPassedTests = 0;
    },
    (value) => {
      value.numTotalTestSuites = 2;
    },
    (value) => {
      value.testResults[0]!.assertionResults[0]!.status = "unknown";
    },
    (value) => {
      value.testResults[0]!.assertionResults[0]!.status = "pending";
      value.numPassedTests = 0;
      value.numPendingTests = 1;
    },
  ];
  for (const mutate of mutations) {
    const value = report();
    mutate(value);
    assert.equal(parse(value).status, "inconclusive", JSON.stringify(value));
  }
  for (const patch of [
    { stdout: "broken-json" },
    { timedOut: true },
    { cancelled: true },
    { truncated: true },
  ])
    assert.equal(parse(report(), patch).status, "inconclusive");
});

test("Vitest never treats zero tests, skipped tests or a nonzero exit as success", () => {
  const empty = report();
  empty.numTotalTests = 0;
  empty.numPassedTests = 0;
  empty.testResults[0]!.assertionResults = [];
  assert.equal(parse(empty).status, "inconclusive");
  const skipped = report();
  skipped.numPassedTests = 0;
  skipped.numPendingTests = 1;
  skipped.testResults[0]!.assertionResults[0]!.status = "skipped";
  assert.equal(parse(skipped).status, "inconclusive");
  assert.equal(parse(report(), { exitCode: 1 }).status, "failed");
  assert.equal(parse(report(), { exitCode: 2 }).status, "error");
  const failed = report();
  failed.success = false;
  failed.numPassedTests = 0;
  failed.numFailedTests = 1;
  failed.testResults[0]!.status = "failed";
  failed.testResults[0]!.assertionResults[0]!.status = "failed";
  assert.equal(parse(failed).status, "failed");
});
