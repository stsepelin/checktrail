import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-mypy", args: [], cwd: "." };
const check: Check = {
  id: "python.mypy",
  adapter: "python",
  project: ".",
  scope: ["value.py"],
  kind: "analysis",
  parser: "mypy-json",
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
  format: "repo-verifier-mypy-1",
  version: "2.3.1",
  files: ["/synthetic/value.py"],
  suppressedFiles: [] as string[],
  stdout: "Success: no issues found in 1 source file\n",
  stderr: "",
  exitCode: 0,
});
const parse = (value: unknown, patch: Partial<ProcessResult> = {}) =>
  evaluate(
    check,
    [{ ...processResult, stdout: JSON.stringify(value), ...patch }],
    "/synthetic",
  );

test("mypy requires exact sources, a reconciled native summary and no broad suppression", () => {
  assert.equal(parse(report()).status, "passed");
  const mutations: ((value: ReturnType<typeof report>) => void)[] = [
    (value) => {
      value.files = [];
    },
    (value) => {
      value.files.push(value.files[0]!);
    },
    (value) => {
      value.files[0] = "/other/value.py";
    },
    (value) => {
      value.suppressedFiles.push(value.files[0]!);
    },
    (value) => {
      value.stdout = "Success: no issues found in 0 source files\n";
    },
    (value) => {
      value.stdout += value.stdout;
    },
    (value) => {
      value.stdout = "some source error\n" + value.stdout;
    },
    (value) => {
      value.stderr = "configuration warning";
    },
    (value) => {
      value.version = "unverified";
    },
    (value) => {
      value.exitCode = 1;
    },
  ];
  for (const mutate of mutations) {
    const value = report();
    mutate(value);
    assert.equal(parse(value).status, "inconclusive", JSON.stringify(value));
  }
  assert.equal(
    parse({ ...report(), exitCode: 1 }, { exitCode: 1 }).status,
    "failed",
  );
  assert.equal(
    parse({ ...report(), exitCode: 2 }, { exitCode: 2 }).status,
    "error",
  );
  assert.equal(
    parse(
      { format: "repo-verifier-mypy-1", unavailable: "unsupported version" },
      { exitCode: 3 },
    ).status,
    "unavailable",
  );
  for (const patch of [
    { stdout: "broken" },
    { timedOut: true },
    { cancelled: true },
    { truncated: true },
  ])
    assert.equal(parse(report(), patch).status, "inconclusive");
});
