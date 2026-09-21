import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-jest", args: [], cwd: "." };
const check: Check = {
  id: "javascript.jest",
  adapter: "javascript",
  project: ".",
  scope: ["sum.test.ts"],
  kind: "test",
  parser: "jest-json",
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
  wasInterrupted: false,
  numRuntimeErrorTestSuites: 0,
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
      testFilePath: "/synthetic/sum.test.ts",
      numPassingTests: 1,
      numFailingTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{ fullName: "adds", status: "passed" }],
    },
  ],
});
const parse = (value: unknown, patch: Partial<ProcessResult> = {}) =>
  evaluate(
    check,
    [{ ...processResult, stdout: JSON.stringify(value), ...patch }],
    "/synthetic",
  );

test("Jest evidence requires matching file paths, terminal assertions and reconciled counters", () => {
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
      value.testResults[0]!.testFilePath = "/other/sum.test.ts";
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
      value.testResults[0]!.testResults[0]!.status = "unknown";
    },
    (value) => {
      value.testResults[0]!.testResults[0]!.status = "pending";
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

test("Jest never treats zero tests, skipped tests or a nonzero exit as success", () => {
  const empty = report();
  empty.numTotalTests = 0;
  empty.numPassedTests = 0;
  empty.testResults[0]!.numPassingTests = 0;
  empty.testResults[0]!.testResults = [];
  assert.equal(parse(empty).status, "inconclusive");
  const skipped = report();
  skipped.numPassedTests = 0;
  skipped.numPendingTests = 1;
  skipped.testResults[0]!.numPassingTests = 0;
  skipped.testResults[0]!.numPendingTests = 1;
  skipped.testResults[0]!.testResults[0]!.status = "pending";
  assert.equal(parse(skipped).status, "inconclusive");
  assert.equal(parse(report(), { exitCode: 1 }).status, "failed");
  assert.equal(parse(report(), { exitCode: 2 }).status, "error");
  const failed = report();
  failed.success = false;
  failed.numPassedTests = 0;
  failed.numFailedTests = 1;
  failed.testResults[0]!.numPassingTests = 0;
  failed.testResults[0]!.numFailingTests = 1;
  failed.testResults[0]!.testResults[0]!.status = "failed";
  assert.equal(parse(failed).status, "failed");
});

test("Jest collection-only output and interrupted runs cannot pass", () => {
  const value = report();
  assert.equal(
    parse({ ...value, wasInterrupted: true }).status,
    "inconclusive",
  );
  for (const wouldRun of [true, false, null]) {
    const collected = {
      ...value,
      testResults: [
        {
          ...value.testResults[0],
          testResults: [{ fullName: "adds", status: "passed", wouldRun }],
        },
      ],
    };
    assert.equal(parse(collected).status, "inconclusive");
  }
});
