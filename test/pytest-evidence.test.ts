import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-pytest", args: [], cwd: "." };
const check: Check = {
  id: "python.pytest",
  adapter: "python",
  project: ".",
  scope: ["test_sum.py"],
  kind: "test",
  parser: "pytest-json",
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
  format: "checktrail-pytest-1",
  version: "9.1.1",
  exitCode: 0,
  finished: true,
  items: [{ id: "test_sum.py::test_adds", file: "/synthetic/test_sum.py" }],
  reports: ["setup", "call", "teardown"].map((phase) => ({
    id: "test_sum.py::test_adds",
    phase,
    outcome: "passed",
    xfail: false,
  })),
  deselected: [] as string[],
  collectionErrors: [] as string[],
});
const parse = (value: unknown, patch: Partial<ProcessResult> = {}) =>
  evaluate(
    check,
    [{ ...processResult, stdout: JSON.stringify(value), ...patch }],
    "/synthetic",
  );

test("pytest evidence requires all lifecycle phases, exact paths, unique IDs and complete collection", () => {
  assert.equal(parse(report()).status, "passed");
  const mutations: ((value: ReturnType<typeof report>) => void)[] = [
    (value) => {
      value.reports.pop();
    },
    (value) => {
      value.reports.shift();
    },
    (value) => {
      value.reports.splice(1, 1);
    },
    (value) => {
      value.reports.push(value.reports[0]!);
    },
    (value) => {
      value.reports[0]!.id = "unknown";
    },
    (value) => {
      value.reports[0]!.outcome = "unknown";
    },
    (value) => {
      value.items[0]!.file = "/other/test_sum.py";
    },
    (value) => {
      value.items.push(value.items[0]!);
    },
    (value) => {
      value.deselected.push("hidden_test");
    },
    (value) => {
      value.finished = false;
    },
    (value) => {
      value.exitCode = 1;
    },
    (value) => {
      value.items = [];
      value.reports = [];
    },
    (value) => {
      value.reports.reverse();
    },
  ];
  for (const mutate of mutations) {
    const value = report();
    mutate(value);
    assert.equal(parse(value).status, "inconclusive", JSON.stringify(value));
  }
  for (const patch of [
    { stdout: "broken" },
    { cancelled: true },
    { timedOut: true },
    { truncated: true },
  ])
    assert.equal(parse(report(), patch).status, "inconclusive");
});

test("pytest treats failure in any lifecycle phase and unexpected passes as failures", () => {
  for (const phase of ["setup", "call", "teardown"]) {
    const value = report();
    value.reports.find((event) => event.phase === phase)!.outcome = "failed";
    if (phase === "setup") value.reports.splice(1, 1);
    assert.equal(parse(value).status, "failed");
  }
  const xpass = report();
  xpass.reports[1]!.xfail = true;
  assert.equal(parse(xpass).status, "failed");
  const skipped = report();
  skipped.reports[1]!.outcome = "skipped";
  assert.equal(parse(skipped).status, "inconclusive");
  const missing = { format: "checktrail-pytest-1", unavailable: "pytest" };
  assert.equal(parse(missing, { exitCode: 3 }).status, "unavailable");
  assert.equal(parse(missing).status, "inconclusive");
});
